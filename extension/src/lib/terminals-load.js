// Load airport terminal footprints — bundled OSM cache + live OpenStreetMap Overpass.
const SKTerminalsLoad = (() => {
  const OVERPASS = "https://overpass-api.de/api/interpreter";
  const BUNDLE_URL = chrome.runtime.getURL("src/data/terminals-bundle.json");
  const RADIUS_M = 4500;
  const CACHE_MS = 30 * 24 * 60 * 60 * 1000;
  const MIN_SPAN_NM = 0.025;
  const NM_R = 3440.065;
  const toRad = (d) => (d * Math.PI) / 180;

  let bundle = null;
  let bundlePromise = null;

  function nmDistance(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return NM_R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function ringSpanNm(ring) {
    let minLat = 90;
    let maxLat = -90;
    let minLon = 180;
    let maxLon = -180;
    for (const p of ring) {
      minLat = Math.min(minLat, p.lat);
      maxLat = Math.max(maxLat, p.lat);
      minLon = Math.min(minLon, p.lon);
      maxLon = Math.max(maxLon, p.lon);
    }
    return nmDistance(minLat, minLon, maxLat, maxLon);
  }

  function ringCentroid(ring) {
    let lat = 0;
    let lon = 0;
    for (const p of ring) {
      lat += p.lat;
      lon += p.lon;
    }
    return { lat: lat / ring.length, lon: lon / ring.length };
  }

  function shouldSkip(tags) {
    const name = (tags?.name || "").toLowerCase();
    const aeroway = (tags?.aeroway || "").toLowerCase();
    if (aeroway && aeroway !== "terminal") return true;
    return /shuttle|parking|rental|bus|cargo|hangar|fire station|fuel|maintenance|admin|control/.test(
      name
    );
  }

  function parseLabel(tags) {
    if (tags?.ref) return String(tags.ref).trim().slice(0, 10);
    const name = (tags?.name || "").trim();
    if (!name) return "";

    const concourse = name.match(/\b([A-Z])\s+Concourse\b/i) || name.match(/Concourse\s+([A-Z])\b/i);
    if (concourse) return concourse[1].toUpperCase();

    const terminalLetter = name.match(/Terminal\s+([A-Z0-9]+)\b/i);
    if (terminalLetter) return terminalLetter[1].toUpperCase();

    const terminalName = name.match(/^(.+?)\s+Terminal$/i);
    if (terminalName) return terminalName[1].trim().slice(0, 14);

    if (/concourse$/i.test(name)) return name.replace(/\s*concourse\s*$/i, "").trim().slice(0, 14);
    return name.slice(0, 14);
  }

  function elementToTerminal(el) {
    if (!el?.geometry?.length || el.geometry.length < 4) return null;
    const tags = el.tags || {};
    if (shouldSkip(tags)) return null;

    const ring = el.geometry.map((p) => ({ lat: p.lat, lon: p.lon }));
    const span = ringSpanNm(ring);
    if (span < MIN_SPAN_NM) return null;

    const label = parseLabel(tags);
    if (!label) return null;

    const cen = ringCentroid(ring);
    return {
      label,
      name: tags.name || null,
      lat: cen.lat,
      lon: cen.lon,
      ring,
      spanNm: span,
    };
  }

  function normalizeTerminal(t) {
    if (!t?.ring?.length || !t.label) return null;
    const ring = t.ring.map((p) => ({ lat: p.lat, lon: p.lon }));
    const span = t.spanNm || ringSpanNm(ring);
    if (span < MIN_SPAN_NM) return null;
    const cen = t.lat != null && t.lon != null ? { lat: t.lat, lon: t.lon } : ringCentroid(ring);
    return {
      label: t.label,
      name: t.name || null,
      lat: cen.lat,
      lon: cen.lon,
      ring,
      spanNm: span,
    };
  }

  function dedupeTerminals(list) {
    const byLabel = new Map();
    for (const t of list) {
      const norm = normalizeTerminal(t);
      if (!norm) continue;
      const key = norm.label.toLowerCase();
      const prev = byLabel.get(key);
      if (!prev || norm.spanNm > prev.spanNm) byLabel.set(key, norm);
    }
    return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  function identVariants(icao) {
    const s = (icao || "").trim().toUpperCase();
    const out = new Set([s]);
    if (s.length === 3) out.add(`K${s}`);
    if (s.startsWith("K") && s.length === 4) out.add(s.slice(1));
    return [...out];
  }

  async function ensureBundle() {
    if (bundle) return bundle;
    if (!bundlePromise) {
      bundlePromise = (async () => {
        const r = await fetch(BUNDLE_URL, { cache: "force-cache" });
        if (!r.ok) throw new Error(`Terminal bundle HTTP ${r.status}`);
        const data = await r.json();
        bundle = data?.airports || {};
        return bundle;
      })().catch((e) => {
        bundlePromise = null;
        bundle = {};
        return bundle;
      });
    }
    return bundlePromise;
  }

  function fromBundle(icao) {
    if (!bundle) return [];
    for (const id of identVariants(icao)) {
      const hit = bundle[id];
      if (hit?.terminals?.length) return hit.terminals;
    }
    return [];
  }

  function overpassQuery(lat, lon, radiusM) {
    return `[out:json][timeout:25];(way["aeroway"="terminal"](around:${radiusM},${lat},${lon});relation["aeroway"="terminal"](around:${radiusM},${lat},${lon});way["building"="terminal"](around:${radiusM},${lat},${lon}););out geom;`;
  }

  async function fetchFromOsm(lat, lon) {
    const q = overpassQuery(lat, lon, RADIUS_M);
    const url = `${OVERPASS}?data=${encodeURIComponent(q)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      // NOTE: no custom User-Agent header — it's a forbidden fetch header that
      // the browser silently strips, so setting it just triggered a console
      // warning. Overpass identifies the caller by origin instead.
      const r = await fetch(url, {
        cache: "default",
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`Overpass HTTP ${r.status}`);
      const data = await r.json();
      const elements = Array.isArray(data?.elements) ? data.elements : [];
      return dedupeTerminals(elements.map(elementToTerminal).filter(Boolean));
    } finally {
      clearTimeout(timer);
    }
  }

  function pickBest(osm, bundled) {
    const merged = dedupeTerminals([...osm, ...bundled]);
    if (!merged.length) return { terminals: [], source: null };
    const osmN = osm.length;
    const bundleN = bundled.length;
    let source = "openstreetmap";
    if (osmN === 0 && bundleN > 0) source = "openstreetmap-bundle";
    else if (osmN > 0 && bundleN > 0) source = "openstreetmap+bundle";
    else if (osmN > 0) source = "openstreetmap";
    return { terminals: merged, source };
  }

  async function fetchForAirport(icao, lat, lon) {
    const id = (icao || "").trim().toUpperCase();
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return { ok: false, error: "Missing airport coordinates" };
    }

    const cacheKey = `term_${id}`;
    const cached = await chrome.storage.local.get(cacheKey);
    const hit = cached[cacheKey];
    if (hit?.terminals && Date.now() - (hit.ts || 0) < CACHE_MS) {
      return {
        ok: hit.terminals.length > 0,
        ident: id,
        terminals: hit.terminals,
        source: hit.source || "cache",
      };
    }

    await ensureBundle();
    const bundled = dedupeTerminals(fromBundle(id).map(normalizeTerminal).filter(Boolean));

    try {
      const osm = await fetchFromOsm(lat, lon);
      const picked = pickBest(osm, bundled);
      const result = {
        ok: picked.terminals.length > 0,
        ident: id,
        terminals: picked.terminals,
        source: picked.source,
        ts: Date.now(),
      };
      chrome.storage.local.set({ [cacheKey]: result }).catch(() => {});
      return result;
    } catch (e) {
      if (bundled.length) {
        const result = {
          ok: true,
          ident: id,
          terminals: bundled,
          source: "openstreetmap-bundle",
          ts: Date.now(),
        };
        chrome.storage.local.set({ [cacheKey]: result }).catch(() => {});
        return result;
      }
      if (hit?.terminals) {
        return {
          ok: hit.terminals.length > 0,
          ident: id,
          terminals: hit.terminals,
          source: "cache-stale",
        };
      }
      return { ok: false, error: String(e) };
    }
  }

  return { fetchForAirport };
})();
