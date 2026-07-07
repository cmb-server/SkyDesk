// Aircraft feed helpers — loaded in the MV3 service worker via importScripts.
const SKFeed = (() => {
  const NM_R = 3440.065;
  const toRad = (d) => (d * Math.PI) / 180;

  function nmDistance(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return NM_R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function bearing(lat1, lon1, lat2, lon2) {
    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x =
      Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
      Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  function normalizeList(list, airport) {
    return list
      .filter((a) => a.lat != null && a.lon != null)
      .map((a) => ({
        ...a,
        dst: a.dst ?? nmDistance(airport.lat, airport.lon, a.lat, a.lon),
        dir: a.dir ?? bearing(airport.lat, airport.lon, a.lat, a.lon),
        track: a.track ?? a.calc_track ?? null,
        gs: a.gs ?? a.tas ?? null,
        flight: (a.flight || "").trim() || a.r || a.hex,
      }));
  }

  function bbox(lat, lon, distNm) {
    const latDelta = distNm / 60;
    const cosLat = Math.max(0.15, Math.cos(toRad(lat)));
    const lonDelta = distNm / (60 * cosLat);
    return {
      lamin: lat - latDelta,
      lamax: lat + latDelta,
      lomin: lon - lonDelta,
      lomax: lon + lonDelta,
    };
  }

  // OpenSky state vectors report metric units (baro_altitude in metres, velocity
  // in m/s, vertical_rate in m/s) whereas every other feed — and the renderer —
  // expects feet/knots/fpm. Convert here so a plane that wins the merge from
  // OpenSky isn't shown at ~1/3 its real altitude/speed.
  const M_TO_FT = 3.28084;
  const MS_TO_KT = 1.943844;
  const MS_TO_FPM = 196.8504; // m/s → feet per minute

  function parseOpensky(data, airport, distNm) {
    const states = data?.states || [];
    const list = states
      .filter((s) => s && s[5] != null && s[6] != null)
      .map((s) => ({
        hex: s[0],
        flight: (s[1] || "").trim(),
        lat: s[6],
        lon: s[5],
        alt_baro: Number.isFinite(s[7]) ? s[7] * M_TO_FT : null,
        gs: Number.isFinite(s[9]) ? s[9] * MS_TO_KT : null,
        track: s[10],
        baro_rate: Number.isFinite(s[11]) ? s[11] * MS_TO_FPM : null,
        squawk: s[14],
      }));
    return normalizeList(list, airport).filter((a) => a.dst <= distNm);
  }

  async function fetchJson(url, ms = 6000, init = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

  const MIN_SOURCE_INTERVAL_MS = 2000;
  const SOURCE_STALE_MS = 45000;
  const NEGATIVE_CACHE_MS = 12000;
  const SOURCES_PER_CYCLE = 2;
  const MAX_AIRCRAFT = 500;
  const sourceLastFetch = Object.create(null);
  const sourceCache = Object.create(null); // id -> { ac, ts }
  const sourceNegative = Object.create(null); // id -> failTs
  let primaryRotate = 0;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function canPollSource(id) {
    const last = sourceLastFetch[id] || 0;
    return Date.now() - last >= MIN_SOURCE_INTERVAL_MS;
  }

  function markSourcePolled(id) {
    sourceLastFetch[id] = Date.now();
  }

  // Lower = fresher position (seen is seconds ago; t is epoch seconds).
  function acFreshness(ac) {
    if (ac?.seen != null && Number.isFinite(Number(ac.seen))) return Number(ac.seen);
    if (ac?.t != null && Number.isFinite(Number(ac.t))) return -Number(ac.t);
    return 9999;
  }

  function mergeByHex(results, airport) {
    const byHex = new Map();
    const used = [];
    for (const { source, ac } of results) {
      if (ac.length) used.push(source);
      for (const a of ac) {
        const hex = String(a.hex || "").toLowerCase();
        if (!hex) continue;
        const prev = byHex.get(hex);
        if (!prev || acFreshness(a) < acFreshness(prev.ac)) {
          byHex.set(hex, { ac: a, source });
        }
      }
    }
    const merged = normalizeList([...byHex.values()].map((v) => v.ac), airport);
    const source = used.length > 1 ? used.join("+") : used[0] || "merged";
    return { ac: merged, source };
  }

  async function fetchAdsbLol(airport, dist) {
    const urls = [
      `https://api.adsb.lol/v2/lat/${airport.lat}/lon/${airport.lon}/dist/${dist}`,
      `https://api.adsb.lol/v2/point/${airport.lat}/${airport.lon}/${dist}`,
    ];
    const tryUrl = (url) =>
      fetchJson(url, 4000).then((data) => {
        const ac = normalizeList(data?.ac || [], airport);
        return { source: "adsb.lol", ac };
      });
    const hit = await Promise.any(urls.map(tryUrl));
    return hit;
  }

  async function fetchOpenSky(airport, dist) {
    const b = bbox(airport.lat, airport.lon, dist);
    const url =
      `https://opensky-network.org/api/states/all?lamin=${b.lamin}&lomin=${b.lomin}` +
      `&lamax=${b.lamax}&lomax=${b.lomax}`;
    const data = await fetchJson(url, 7000);
    const ac = parseOpensky(data, airport, dist);
    return { source: "opensky", ac };
  }

  async function fetchAdsbFi(airport, dist) {
    const url =
      `https://opendata.adsb.fi/api/v3/lat/${airport.lat}/lon/${airport.lon}/dist/${dist}`;
    const data = await fetchJson(url, 5000);
    const ac = normalizeList(data?.ac || [], airport);
    return { source: "adsb.fi", ac };
  }

  async function fetchAirplanesLive(airport, dist) {
    const url = `https://api.airplanes.live/v2/point/${airport.lat}/${airport.lon}/${dist}`;
    const data = await fetchJson(url, 5000);
    const ac = normalizeList(data?.ac || [], airport);
    return { source: "airplanes.live", ac };
  }

  function isSourceNegative(id) {
    const t = sourceNegative[id];
    return t != null && Date.now() - t < NEGATIVE_CACHE_MS;
  }

  async function pollSource(id, fn) {
    if (isSourceNegative(id)) return null;
    if (!canPollSource(id)) return null;
    markSourcePolled(id);
    try {
      const result = await fn();
      delete sourceNegative[id];
      return result;
    } catch (e) {
      sourceNegative[id] = Date.now();
      throw new Error(`${id}: ${e?.message || e}`);
    }
  }

  function capAircraft(list, max = MAX_AIRCRAFT) {
    if (!list || list.length <= max) return list;
    return list.slice().sort((a, b) => (a.dst ?? 99999) - (b.dst ?? 99999)).slice(0, max);
  }

  function locationKey(lat, lon, dist) {
    return `${Number(lat).toFixed(3)},${Number(lon).toFixed(3)},${dist}`;
  }

  async function fetchAircraft(lat, lon, distNm) {
    const airport = { lat: Number(lat), lon: Number(lon) };
    const dist = Math.max(5, Math.min(250, Number(distNm) || 40));
    const locKey = locationKey(airport.lat, airport.lon, dist);
    const errors = [];

    const sources = [
      { id: "adsb.lol", fn: () => fetchAdsbLol(airport, dist) },
      { id: "opensky", fn: () => fetchOpenSky(airport, dist) },
      { id: "adsb.fi", fn: () => fetchAdsbFi(airport, dist) },
      { id: "airplanes.live", fn: () => fetchAirplanesLive(airport, dist) },
    ];

    // Poll two rotated sources per cycle; merge with cached results from the
    // others so a full 4-source picture builds over ~2 refresh intervals.
    const rot = primaryRotate++ % sources.length;
    const toPoll = [];
    for (let i = 0; i < SOURCES_PER_CYCLE; i++) {
      toPoll.push(sources[(rot + i) % sources.length]);
    }

    for (let i = 0; i < toPoll.length; i++) {
      if (i > 0) await sleep(400);
      const src = toPoll[i];
      try {
        const hit = await pollSource(src.id, src.fn);
        if (hit) sourceCache[src.id] = { ac: hit.ac, ts: Date.now(), locKey };
      } catch (e) {
        errors.push(String(e.message || e));
      }
    }

    const mergeInputs = [];
    for (const src of sources) {
      const cached = sourceCache[src.id];
      if (
        cached &&
        cached.locKey === locKey &&
        Date.now() - cached.ts < SOURCE_STALE_MS &&
        Array.isArray(cached.ac)
      ) {
        mergeInputs.push({ source: src.id, ac: cached.ac });
      }
    }

    if (!mergeInputs.length) {
      return { ok: false, error: errors.join(" · ") || "All feeds failed" };
    }

    const { ac, source } = mergeByHex(mergeInputs, airport);
    const capped = capAircraft(ac);
    return {
      ok: true,
      source,
      data: { ac: capped, total: capped.length },
      partialErrors: errors.length ? errors : undefined,
    };
  }

  // Common IATA airline codes → ICAO telephony prefixes used in ATC callsigns.
  // adsb.lol's /callsign/ endpoint is keyed on the ICAO callsign (e.g. "DAL123"),
  // but users typically type the IATA flight number ("DL123"), so we expand the
  // input into candidate callsigns to try.
  const AIRLINE_IATA_ICAO = {
    AA: "AAL", DL: "DAL", UA: "UAL", WN: "SWA", B6: "JBU", AS: "ASA", NK: "NKS",
    F9: "FFT", HA: "HAL", G4: "AAY", AC: "ACA", WS: "WJA", AM: "AMX", LA: "LAN",
    AV: "AVA", CM: "CMP", BA: "BAW", VS: "VIR", EI: "EIN", AF: "AFR", KL: "KLM",
    LH: "DLH", LX: "SWR", OS: "AUA", EW: "EWG", SK: "SAS", AY: "FIN", IB: "IBE",
    TP: "TAP", AZ: "ITY", TK: "THY", SU: "AFL", EK: "UAE", QR: "QTR", EY: "ETD",
    SV: "SVA", MS: "MSR", AT: "RAM", ET: "ETH", SA: "SAA", QF: "QFA", NZ: "ANZ",
    SQ: "SIA", CX: "CPA", NH: "ANA", JL: "JAL", KE: "KAL", OZ: "AAR", TG: "THA",
    MH: "MAS", GA: "GIA", AI: "AIC", "6E": "IGO", CA: "CCA", CZ: "CSN", MU: "CES",
  };

  // Expand a typed flight number into candidate ATC callsigns, most-likely
  // first. Returns an upper-cased, de-duplicated list.
  function expandCallsign(raw) {
    const s = String(raw || "").toUpperCase().replace(/[\s-]/g, "");
    if (!s) return [];
    const out = [];
    const push = (v) => {
      if (v && !out.includes(v)) out.push(v);
    };
    const m = s.match(/^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/);
    if (m && AIRLINE_IATA_ICAO[m[1]]) push(AIRLINE_IATA_ICAO[m[1]] + m[2]);
    push(s);
    return out;
  }

  function pickLive(list, cs) {
    const a = list.slice().sort((x, y) => (x.seen ?? 999) - (y.seen ?? 999))[0];
    return {
      hex: a.hex,
      flight: (a.flight || cs).trim(),
      lat: a.lat,
      lon: a.lon,
      track: a.track ?? a.true_heading ?? null,
      alt_baro: a.alt_baro,
      gs: a.gs ?? null,
      squawk: a.squawk ?? null,
      emergency: a.emergency ?? null,
      t: a.t || null,
    };
  }

  // Live position for a flight number. Tries IATA→ICAO callsign candidates and
  // returns the best match (most recently seen) plus the callsign that matched,
  // so the route lookup can reuse it.
  async function fetchCallsign(callsign) {
    const candidates = expandCallsign(callsign);
    if (!candidates.length) return { ok: false, error: "No callsign" };
    let lastErr = null;
    for (const cs of candidates) {
      try {
        const data = await fetchJson(`https://api.adsb.lol/v2/callsign/${encodeURIComponent(cs)}`, 5000);
        const list = (data?.ac || []).filter((a) => a.lat != null && a.lon != null);
        if (list.length) return { ok: true, matched: cs, live: pickLive(list, cs) };
      } catch (e) {
        lastErr = e;
      }
    }
    // No live hit. Only surface an error if every candidate request actually
    // failed — an empty result still lets the route/airports render.
    if (lastErr) return { ok: false, error: String(lastErr.message || lastErr) };
    return { ok: true, matched: candidates[0], live: null };
  }

  // A real, usable fix: finite lat/lon that isn't the 0,0 "null island"
  // placeholder some callers pass when the live position is unknown.
  function hasRealPos(lat, lon) {
    const la = Number(lat);
    const lo = Number(lon);
    return (
      Number.isFinite(la) &&
      Number.isFinite(lo) &&
      la >= -90 &&
      la <= 90 &&
      lo >= -180 &&
      lo <= 180 &&
      !(la === 0 && lo === 0)
    );
  }

  // "Excess" path length: how far a point sits off the great-circle segment A→B.
  // Equals ~0 when the aircraft is on the leg between A and B, and grows both
  // when it is off to the side and when it is beyond either endpoint. Used to
  // pick the matching leg of a multi-stop route and to validate fallback routes.
  function legExcessNm(lat, lon, a, b) {
    if (!a || !b || a.lat == null || b.lat == null) return Infinity;
    const legNm = nmDistance(a.lat, a.lon, b.lat, b.lon);
    return (
      nmDistance(lat, lon, a.lat, a.lon) +
      nmDistance(lat, lon, b.lat, b.lon) -
      legNm
    );
  }

  // Multi-stop standing routes (>2 airports) collapse incorrectly to first/last.
  // Pick the consecutive airport pair the aircraft is currently flying between
  // (nearest leg by great-circle excess) so a later leg shows the right
  // origin/destination instead of the whole route's endpoints.
  function pickLeg(airports, lat, lon) {
    const valid = airports.filter((a) => a && a.lat != null && a.lon != null);
    if (valid.length < 2) {
      return {
        dep: airports[0] || null,
        arr: airports.length > 1 ? airports[airports.length - 1] : null,
      };
    }
    let best = { dep: valid[0], arr: valid[valid.length - 1] };
    let bestScore = Infinity;
    for (let i = 0; i < valid.length - 1; i++) {
      const excess = legExcessNm(lat, lon, valid[i], valid[i + 1]);
      if (excess < bestScore) {
        bestScore = excess;
        best = { dep: valid[i], arr: valid[i + 1] };
      }
    }
    return best;
  }

  // How far off the dep→arr leg an aircraft may be before we stop asserting the
  // route is the one it's actually flying (excess metric is forgiving on long
  // legs, so this comfortably allows airway routing / weather diversions while
  // still rejecting an obviously stale route — e.g. MSP→BOS for a plane over MS).
  const ROUTE_MAX_EXCESS_NM = 120;
  const ROUTE_MAX_ENDPOINT_NM = 250;

  // Validate a route's geometry against the live position. Returns true when the
  // aircraft plausibly lies on the dep→arr leg, false when it clearly does not,
  // and null when there isn't enough data to decide (no position / no coords).
  function routePlausibleForPosition(dep, arr, lat, lon) {
    if (!hasRealPos(lat, lon)) return null;
    const ends = [];
    if (dep && dep.lat != null) ends.push(dep);
    if (arr && arr.lat != null) ends.push(arr);
    if (!ends.length) return null;
    if (ends.length === 1) {
      return nmDistance(lat, lon, ends[0].lat, ends[0].lon) <= ROUTE_MAX_ENDPOINT_NM;
    }
    return legExcessNm(lat, lon, ends[0], ends[1]) <= ROUTE_MAX_EXCESS_NM;
  }

  // Primary route source: adsb.lol routeset (POST) — returns airport coords
  // inline. Wrapped with an abort timeout so an adsb.lol outage can't hang the
  // lookup forever.
  //
  // IMPORTANT: routeset is static, callsign-keyed standing/filed data. adsb.lol
  // uses the lat/lng we pass ONLY to compute a `plausible` flag — it does NOT
  // pick the route for us. A reused flight number therefore yields a stale route
  // unless we honor `plausible`, so we capture it and plumb it back to callers.
  async function fetchRouteAdsb(cs, lat, lon) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const plane = { callsign: cs };
      if (hasRealPos(lat, lon)) {
        plane.lat = Number(lat);
        plane.lng = Number(lon);
      }
      const r = await fetch("https://api.adsb.lol/api/0/routeset", {
        method: "POST",
        headers: { accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ planes: [plane] }),
        cache: "no-store",
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const hit = Array.isArray(data) ? data[0] : data;
      const airports = (hit?._airports || []).filter((a) => a && (a.icao || a.iata || a.lat != null));
      if (!airports.length) return null;

      const posKnown = hasRealPos(lat, lon);
      // Trust adsb.lol's plausibility verdict ONLY when we actually supplied a
      // real position for it to judge against; otherwise leave it undecided.
      const raw = hit?.plausible;
      const plausible = posKnown ? !(raw === false || raw === 0) : null;

      // For a multi-stop standing route, select the leg the aircraft is on now;
      // only fall back to first/last for a simple 2-airport route (RC2).
      let dep;
      let arr;
      if (airports.length > 2 && posKnown) {
        const leg = pickLeg(airports, Number(lat), Number(lon));
        dep = leg.dep;
        arr = leg.arr;
      } else {
        dep = airports[0] || null;
        // Only treat the last airport as the destination when it's genuinely a
        // different airport. adsb.lol sometimes returns a single airport (which
        // would otherwise be shown as both FROM and TO — a duplicated origin).
        arr = airports.length > 1 ? airports[airports.length - 1] : null;
      }
      if (dep && arr && dep.icao && dep.icao === arr.icao) arr = null;
      if (!dep && !arr) return null;
      const fmt = (a) =>
        a ? { icao: a.icao, iata: a.iata, name: a.name || a.location, lat: a.lat, lon: a.lon } : null;
      return {
        callsign: hit.callsign || cs,
        codes: hit._airport_codes_iata || hit.airport_codes || "",
        dep: fmt(dep),
        arr: fmt(arr),
        plausible,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // Fallback route source: hexdb.io. Returns "DEP-ARR" ICAO codes only, so we
  // resolve each airport's coordinates with a second (cached) lookup.
  const hexAptCache = new Map();
  async function fetchAirportHexdb(icao) {
    if (!icao) return null;
    if (hexAptCache.has(icao)) return hexAptCache.get(icao);
    let out = null;
    try {
      const a = await fetchJson(`https://hexdb.io/api/v1/airport/icao/${encodeURIComponent(icao)}`, 5000);
      if (a && a.latitude != null) {
        out = { icao: a.icao || icao, iata: a.iata || "", name: a.airport || "", lat: a.latitude, lon: a.longitude };
      }
    } catch (_) {
      out = null;
    }
    hexAptCache.set(icao, out);
    return out;
  }

  async function fetchRouteHexdb(cs) {
    let data;
    try {
      data = await fetchJson(`https://hexdb.io/api/v1/route/icao/${encodeURIComponent(cs)}`, 5000);
    } catch (_) {
      return null;
    }
    const parts = String(data?.route || "").trim().split("-").filter(Boolean);
    if (parts.length < 2) return null;
    const depCode = parts[0];
    const arrCode = parts[parts.length - 1];
    const [dep, arr] = await Promise.all([
      fetchAirportHexdb(depCode),
      // Avoid resolving the same airport twice when origin === destination.
      depCode === arrCode ? Promise.resolve(null) : fetchAirportHexdb(arrCode),
    ]);
    if (!dep && !arr) return null;
    return {
      callsign: data.flight || cs,
      codes: arr ? [dep?.iata || depCode, arr?.iata || arrCode].join("-") : dep?.iata || depCode,
      dep,
      arr,
    };
  }

  // Normalize aircraft registration / tail number for matching and API lookup.
  function normalizeTail(raw) {
    let s = String(raw || "").toUpperCase().replace(/[\s.-]/g, "");
    if (!s) return "";
    if (/^\d{1,5}[A-Z]{0,2}$/.test(s)) s = "N" + s;
    return s;
  }

  function tailCandidates(raw) {
    const n = normalizeTail(raw);
    if (!n) return [];
    const out = [];
    const push = (v) => {
      if (v && !out.includes(v)) out.push(v);
    };
    push(n);
    const m1 = n.match(/^([A-Z])([A-Z]{3,4})$/);
    if (m1) push(`${m1[1]}-${m1[2]}`);
    const m2 = n.match(/^([A-Z]{2})([A-Z]{3})$/);
    if (m2) push(`${m2[1]}-${m2[2]}`);
    return out;
  }

  function acMatchesTail(ac, tailRaw) {
    const want = normalizeTail(tailRaw);
    if (!want || !ac) return false;
    const reg = normalizeTail(ac.r || ac.registration || "");
    if (reg && reg === want) return true;
    if (!reg) {
      const fl = String(ac.flight || "").trim().toUpperCase().replace(/[\s.-]/g, "");
      if (fl && fl === want) return true;
    }
    return false;
  }

  async function fetchRegistration(reg) {
    const candidates = tailCandidates(reg);
    if (!candidates.length) return { ok: false, error: "No registration" };
    let lastErr = null;
    for (const tail of candidates) {
      for (const path of [
        `reg/${encodeURIComponent(tail)}`,
        `registration/${encodeURIComponent(tail)}`,
      ]) {
        try {
          const data = await fetchJson(`https://api.adsb.lol/v2/${path}`, 5000);
          const list = (data?.ac || []).filter((a) => a.lat != null && a.lon != null);
          if (list.length) return { ok: true, matched: tail, live: pickLive(list, tail) };
        } catch (e) {
          lastErr = e;
        }
      }
    }
    if (lastErr) return { ok: false, error: String(lastErr.message || lastErr) };
    return { ok: true, matched: candidates[0], live: null };
  }

  // Actual flown track ("trace") for an aircraft, from adsb.lol's readsb globe
  // history. Returns the real path the aircraft has flown (curved, airway-
  // following) so the overlay can draw it instead of a straight dep→arr line.
  //
  // Endpoint: https://adsb.lol/data/traces/{xx}/trace_{recent|full}_{hex}.json
  //   - {xx} is the last two hex chars of the ICAO address.
  //   - trace_recent ≈ last ~1h (small, ~a few KB), trace_full = whole UTC day.
  //   - Served Content-Encoding: gzip with Content-Type application/json, so the
  //     browser auto-decompresses and r.json() works directly.
  // Format (per readsb): top-level { icao, r, t, timestamp, trace: [...] } where
  // each trace entry is [secAfterTs, lat, lon, alt, gs, track, flags, vrate, …].
  const traceCache = new Map(); // hex -> { ts, result }
  const TRACE_TTL_MS = 15000;
  const TRACE_MAX_POINTS = 2000;

  async function fetchTrace(hex, opts = {}) {
    const recent = opts.recent !== false; // default to the lighter recent trace
    const h = String(hex || "").toLowerCase().replace(/[^0-9a-f]/g, "");
    if (h.length < 6) return { ok: false, error: "No hex" };

    const cacheKey = `${h}:${recent ? "r" : "f"}`;
    const cached = traceCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < TRACE_TTL_MS) return cached.result;

    const sub = h.slice(-2);
    const kind = recent ? "trace_recent" : "trace_full";
    const url = `https://adsb.lol/data/traces/${sub}/${kind}_${h}.json`;

    let data;
    try {
      data = await fetchJson(url, 7000);
    } catch (e) {
      const result = { ok: false, error: String(e?.message || e) };
      traceCache.set(cacheKey, { ts: Date.now(), result });
      return result;
    }

    const arr = Array.isArray(data?.trace) ? data.trace : [];
    const base = Number(data?.timestamp) || 0;
    const points = []; // [lon, lat] pairs, oldest → newest (matches worldmap/great-circle)
    let lastLat = null;
    let lastLon = null;
    for (const e of arr) {
      if (!Array.isArray(e) || e.length < 3) continue;
      const lat = Number(e[1]);
      const lon = Number(e[2]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (lat === lastLat && lon === lastLon) continue; // drop idle/duplicate fixes
      points.push([lon, lat]);
      lastLat = lat;
      lastLon = lon;
    }

    if (points.length < 2) {
      const result = { ok: false, error: "No trace points" };
      traceCache.set(cacheKey, { ts: Date.now(), result });
      return result;
    }

    // Evenly downsample very long traces so a full-day path stays cheap to draw,
    // always preserving the final (most recent) fix.
    let pts = points;
    if (pts.length > TRACE_MAX_POINTS) {
      const step = Math.ceil(pts.length / TRACE_MAX_POINTS);
      const thinned = [];
      for (let i = 0; i < pts.length; i += step) thinned.push(pts[i]);
      const last = pts[pts.length - 1];
      if (thinned[thinned.length - 1] !== last) thinned.push(last);
      pts = thinned;
    }

    const result = {
      ok: true,
      trace: {
        hex: h,
        reg: data.r || null,
        type: data.t || null,
        updated: base ? Math.round(base * 1000) : Date.now(),
        points: pts,
      },
    };
    traceCache.set(cacheKey, { ts: Date.now(), result });
    return result;
  }

  async function fetchRoute(callsign, lat, lon) {
    const cs = (callsign || "").trim().toUpperCase();
    if (!cs) return { ok: false, error: "No callsign" };
    const posKnown = hasRealPos(lat, lon);

    let route = null;
    try {
      route = await fetchRouteAdsb(cs, lat, lon);
    } catch (_) {
      route = null;
    }

    // adsb.lol's `plausible` flag judges the whole standing itinerary; we may
    // have already picked a single leg. Re-check our dep→arr against the live
    // fix before discarding — only reject when our geometry check also fails.
    if (route && route.plausible === false) {
      const local = routePlausibleForPosition(route.dep, route.arr, lat, lon);
      if (local === true) {
        route.plausible = true;
      } else if (local === false) {
        route = null;
      } else {
        route.plausible = null;
      }
    }

    if (!route || (!route.dep && !route.arr)) {
      const fb = await fetchRouteHexdb(cs).catch(() => null);
      if (fb) {
        // hexdb is also static callsign-keyed data, so subject it to the same
        // "don't show a wrong route" rule: validate its geometry against the
        // live position when we have one (RC4). Unknown (null) → accept but
        // leave undecided; clearly off-route (false) → treat as unknown.
        const ok = routePlausibleForPosition(fb.dep, fb.arr, lat, lon);
        if (ok === false) {
          return { ok: false, error: "Route not plausible for current position", plausible: false };
        }
        fb.plausible = ok; // true when validated, null when position unknown
        route = fb;
      }
    }

    if (!route) return { ok: false, error: "Route not found" };
    return { ok: true, route, plausible: route.plausible ?? (posKnown ? true : null) };
  }

  // Try IATA→ICAO expansions (e.g. DL3060 → DAL3060) before giving up.
  async function fetchRouteForCallsign(raw, lat, lon) {
    const typed = String(raw || "").trim().toUpperCase();
    if (!typed) return { ok: false, error: "No callsign" };
    const candidates = [];
    const seen = new Set();
    const push = (v) => {
      if (v && !seen.has(v)) {
        seen.add(v);
        candidates.push(v);
      }
    };
    for (const c of expandCallsign(typed)) push(c);
    push(typed);

    let lastFail = null;
    for (const cs of candidates) {
      const rr = await fetchRoute(cs, lat, lon);
      if (rr.ok) return rr;
      lastFail = rr;
    }
    return lastFail || { ok: false, error: "Route not found" };
  }

  return {
    fetchAircraft,
    normalizeList,
    fetchRoute,
    fetchRouteForCallsign,
    fetchTrace,
    fetchCallsign,
    fetchRegistration,
    expandCallsign,
    normalizeTail,
    acMatchesTail,
  };
})();
