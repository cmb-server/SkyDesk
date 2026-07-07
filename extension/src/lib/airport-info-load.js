// Public airport metadata — FAA Aviation Weather Center + OurAirports.
const SKAirportInfoLoad = (() => {
  const AWC_URL = "https://aviationweather.gov/api/data/airport";
  const OA_FREQ_URL =
    "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airport-frequencies.csv";
  const OA_AIRPORTS_URL =
    "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv";
  const CACHE_MS = 7 * 24 * 60 * 60 * 1000;

  let freqIndex = null;
  let freqPromise = null;

  // Global airport-metadata index (name/elevation/type/municipality/country/iata),
  // built lazily from OurAirports airports.csv and kept in memory only. We do NOT
  // persist the whole index — final per-airport results are already cached under
  // aptinfo_<id> — and this parse only runs when AWC has no data (i.e. non-US),
  // so the US path keeps its original cold-start cost with no regression.
  let aptIndex = null;
  let aptPromise = null;

  function norm(s) {
    return (s || "").trim().toUpperCase();
  }

  function faaIdent(icao) {
    const s = norm(icao);
    if (s.length === 4 && s.startsWith("K")) return s;
    if (s.length === 3) return `K${s}`;
    return s;
  }

  function identVariants(icao) {
    const s = norm(icao);
    const out = new Set([s]);
    if (s.length === 3) out.add(`K${s}`);
    if (s.startsWith("K") && s.length === 4) out.add(s.slice(1));
    return [...out];
  }

  function parseCsvLine(line) {
    const fields = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        inQ = !inQ;
        continue;
      }
      if (c === "," && !inQ) {
        fields.push(cur);
        cur = "";
        continue;
      }
      cur += c;
    }
    fields.push(cur);
    return fields;
  }

  async function ensureFreqIndex() {
    if (freqIndex) return freqIndex;
    if (!freqPromise) {
      freqPromise = (async () => {
        const r = await fetch(OA_FREQ_URL, { cache: "default" });
        if (!r.ok) throw new Error(`Frequencies CSV HTTP ${r.status}`);
        const lines = (await r.text()).split(/\r?\n/);
        const map = {};
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          if (!line) continue;
          const f = parseCsvLine(line);
          const ident = norm(f[2]);
          if (!ident) continue;
          const entry = {
            type: (f[3] || "").trim(),
            desc: (f[4] || "").trim(),
            mhz: parseFloat(f[5]) || null,
          };
          if (!entry.mhz) continue;
          if (!map[ident]) map[ident] = [];
          map[ident].push(entry);
        }
        freqIndex = map;
        return map;
      })().catch((e) => {
        freqPromise = null;
        throw e;
      });
    }
    return freqPromise;
  }

  function intOrNull(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }

  function floatOrNull(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }

  // OurAirports airports.csv columns:
  // 0 id, 1 ident, 2 type, 3 name, 4 latitude_deg, 5 longitude_deg, 6 elevation_ft,
  // 7 continent, 8 iso_country, 9 iso_region, 10 municipality, 11 scheduled_service,
  // 12 gps_code, 13 iata_code, 14 local_code, 15 home_link, 16 wikipedia_link
  async function ensureAptIndex() {
    if (aptIndex) return aptIndex;
    if (!aptPromise) {
      aptPromise = (async () => {
        // cache:"default" lets this share the browser HTTP cache with the same
        // airports.csv fetch already done by airports-load.js (no re-download).
        const r = await fetch(OA_AIRPORTS_URL, { cache: "default" });
        if (!r.ok) throw new Error(`Airports CSV HTTP ${r.status}`);
        const lines = (await r.text()).split(/\r?\n/);
        const map = {};
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          if (!line) continue;
          const f = parseCsvLine(line);
          const ident = norm(f[1]);
          if (!ident) continue;
          map[ident] = {
            ident,
            type: (f[2] || "").trim() || null,
            name: (f[3] || "").trim() || null,
            lat: floatOrNull(f[4]),
            lon: floatOrNull(f[5]),
            elevationFt: intOrNull(f[6]),
            country: (f[8] || "").trim() || null,
            municipality: (f[10] || "").trim() || null,
            iata: (f[13] || "").trim() || null,
            wikipedia: (f[16] || "").trim() || null,
          };
        }
        aptIndex = map;
        return map;
      })().catch((e) => {
        aptPromise = null;
        throw e;
      });
    }
    return aptPromise;
  }

  async function lookupApt(id) {
    const idx = await ensureAptIndex();
    for (const v of identVariants(id)) {
      if (idx[v]) return idx[v];
    }
    return null;
  }

  // Reuse runways-load.js (its OurAirports runways.csv fetch + chrome.storage cache +
  // in-memory index) instead of downloading/parsing runways.csv again. It exposes
  // length/width, idents, and surface (OurAirports surface code, e.g. ASP/CON/GRS).
  async function lookupRunways(id) {
    if (typeof SKRunwaysLoad === "undefined" || !SKRunwaysLoad?.fetchForIcao) return [];
    const res = await SKRunwaysLoad.fetchForIcao(id);
    if (!res?.ok || !Array.isArray(res.runways)) return [];
    return res.runways.map((rw) => {
      const ident =
        rw.rwy ||
        (rw.le_ident && rw.he_ident
          ? `${rw.le_ident}/${rw.he_ident}`
          : rw.le_ident || rw.he_ident || null);
      let dimension = null;
      if (rw.lenFt) dimension = rw.widthFt ? `${rw.lenFt}x${rw.widthFt}` : `${rw.lenFt}`;
      return { id: ident, dimension, surface: rw.surface || null };
    });
  }

  function roleFromType(type) {
    switch (type) {
      case "large_airport":
        return "Large airport";
      case "medium_airport":
        return "Medium airport";
      case "small_airport":
        return "Small airport";
      case "heliport":
        return "Heliport";
      case "seaplane_base":
        return "Seaplane base";
      case "balloonport":
        return "Balloonport";
      default:
        return type || null;
    }
  }

  // Build the same object shape fetchAwc() returns, so the UI needs no changes.
  function buildOaInfo(id, apt, runways) {
    const icao = apt?.ident || id;
    return {
      icao,
      iata: apt?.iata || null,
      faa: null,
      name: apt?.name || id,
      city: apt?.municipality || null,
      state: null,
      country: apt?.country || null,
      source: "OurAirports",
      type: roleFromType(apt?.type),
      lat: apt?.lat ?? null,
      lon: apt?.lon ?? null,
      elevationFt: apt?.elevationFt ?? null,
      magVar: null,
      tower: null,
      runways,
      runwayCount: runways.length,
      passengers: null,
      freqs: [],
      links: {
        awc: null,
        ourairports: `https://ourairports.com/airports/${encodeURIComponent(icao)}/`,
        wikipedia: apt?.wikipedia || null,
      },
    };
  }

  function hasTowerFreq(freqs) {
    return (freqs || []).some((f) => /\bTWR\b|TOWER/i.test(`${f.type || ""} ${f.desc || ""}`));
  }

  function parseAwcFreqs(freqsStr) {
    if (!freqsStr) return [];
    const seen = new Set();
    const out = [];
    for (const part of freqsStr.split(";")) {
      const [type, freq] = part.split(",");
      if (!type || !freq) continue;
      const key = `${type}:${freq}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type: type.trim(), mhz: parseFloat(freq) || freq.trim(), source: "faa" });
    }
    return out;
  }

  function mergeFreqs(awcFreqs, oaFreqs) {
    const out = [...awcFreqs];
    const seen = new Set(awcFreqs.map((f) => `${f.type}:${f.mhz}`));
    for (const f of oaFreqs || []) {
      const key = `${f.type}:${f.mhz}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type: f.type, desc: f.desc, mhz: f.mhz, source: "ourairports" });
    }
    return out.slice(0, 16);
  }

  function formatRunways(runways) {
    if (!Array.isArray(runways)) return [];
    return runways.map((rw) => ({
      id: rw.id || null,
      dimension: rw.dimension || null,
      surface: rw.surface || null,
    }));
  }

  async function fetchAwc(icao) {
    const id = faaIdent(icao);
    const url = `${AWC_URL}?ids=${encodeURIComponent(id)}&format=json`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let data;
    try {
      // No custom User-Agent: it's a forbidden fetch header (silently dropped),
      // so it only produced a console warning without ever reaching the server.
      const r = await fetch(url, {
        cache: "default",
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`AWC HTTP ${r.status}`);
      data = await r.json();
    } finally {
      clearTimeout(timer);
    }
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return null;

    return {
      icao: row.icaoId || id,
      iata: row.iataId || null,
      faa: row.faaId || null,
      name: (row.name || "").trim(),
      city: row.city || null,
      state: row.state || null,
      country: row.country || null,
      source: row.source || "FAA",
      type: row.type || null,
      lat: row.lat,
      lon: row.lon,
      elevationFt: row.elev,
      magVar: row.magdec || null,
      tower: row.tower === "T",
      runways: formatRunways(row.runways),
      runwayCount: row.rwyNum ? Number(row.rwyNum) : row.runways?.length || 0,
      passengers: row.passengers || null,
      freqs: parseAwcFreqs(row.freqs),
      links: {
        awc: `https://aviationweather.gov/data/airport/?ids=${encodeURIComponent(row.icaoId || id)}`,
        ourairports: `https://ourairports.com/airports/${encodeURIComponent(row.icaoId || id)}/`,
        wikipedia: null,
      },
    };
  }

  async function fetchForIcao(icao) {
    const id = norm(icao);
    if (!id) return { ok: false, error: "Missing ICAO" };

    // v2: per-runway `surface` now retained in info.runways; bump so cached
    // pre-surface results rebuild instead of serving runways without surface.
    const cacheKey = `aptinfo2_${id}`;
    const cached = await chrome.storage.local.get(cacheKey);
    const hit = cached[cacheKey];
    if (hit?.info && Date.now() - (hit.ts || 0) < CACHE_MS) {
      return { ok: true, ident: id, info: hit.info, source: hit.source || "cache" };
    }

    try {
      const awc = await fetchAwc(id);
      let oaFreqs = [];
      try {
        const idx = await ensureFreqIndex();
        for (const v of identVariants(id)) {
          if (idx[v]?.length) {
            oaFreqs = idx[v];
            break;
          }
        }
      } catch (_) {}

      // Global metadata fallback: when AWC has nothing (non-US idents), source the
      // airport from OurAirports so international airports get name/elevation/type/
      // municipality/runways instead of frequencies-only. Only runs when !awc, so the
      // US AWC path (richer) is untouched and pays no extra cold-start cost.
      let oaApt = null;
      let oaRunways = [];
      if (!awc) {
        oaApt = await lookupApt(id).catch(() => null);
        oaRunways = await lookupRunways(id).catch(() => []);
      }

      if (!awc && !oaApt && !oaRunways.length && !oaFreqs.length) {
        return { ok: false, error: `No public data for ${id}` };
      }

      const usedOa = !!(oaApt || oaRunways.length || oaFreqs.length);
      const info = awc || buildOaInfo(id, oaApt, oaRunways);
      info.freqs = mergeFreqs(info.freqs || [], oaFreqs);
      if (!awc && info.tower == null) info.tower = hasTowerFreq(info.freqs);
      info.sources = [
        awc ? "FAA Aviation Weather" : null,
        usedOa ? "OurAirports" : null,
      ].filter(Boolean);

      const result = { ok: true, ident: id, info, source: info.sources.join(" + "), ts: Date.now() };
      chrome.storage.local.set({ [cacheKey]: result }).catch(() => {});
      return result;
    } catch (e) {
      if (hit?.info) {
        return { ok: true, ident: id, info: hit.info, source: "cache-stale" };
      }
      return { ok: false, error: String(e) };
    }
  }

  return { fetchForIcao };
})();
