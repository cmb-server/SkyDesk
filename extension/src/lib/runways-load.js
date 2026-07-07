// Load runway centerlines from OurAirports public dataset (real threshold coordinates).
const SKRunwaysLoad = (() => {
  const CSV_URL =
    "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/runways.csv";

  let index = null;
  let loadPromise = null;

  function identVariants(icao) {
    const s = (icao || "").trim().toUpperCase();
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

  function rowToRunway(fields) {
    const closed = fields[7] === "1";
    const leLat = parseFloat(fields[9]);
    const leLon = parseFloat(fields[10]);
    const heLat = parseFloat(fields[15]);
    const heLon = parseFloat(fields[16]);
    if (closed || !Number.isFinite(leLat) || !Number.isFinite(heLat)) return null;

    const le = fields[8] || "";
    const he = fields[14] || "";
    return {
      rwy: le && he ? `${le}/${he}` : le || he,
      le_ident: le,
      he_ident: he,
      le_lat: leLat,
      le_lon: leLon,
      he_lat: heLat,
      he_lon: heLon,
      lenFt: parseInt(fields[3], 10) || null,
      widthFt: parseInt(fields[4], 10) || null,
      surface: (fields[5] || "").trim() || null,
    };
  }

  function buildIndex(csvText) {
    const lines = csvText.split(/\r?\n/);
    const map = {};
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const f = parseCsvLine(line);
      const ident = (f[2] || "").toUpperCase();
      if (!ident) continue;
      const rw = rowToRunway(f);
      if (!rw) continue;
      if (!map[ident]) map[ident] = [];
      map[ident].push(rw);
    }
    return map;
  }

  async function loadIndex() {
    if (index) return index;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(CSV_URL, { cache: "default", signal: ctrl.signal });
      if (!r.ok) throw new Error(`Runways CSV HTTP ${r.status}`);
      index = buildIndex(await r.text());
      return index;
    } finally {
      clearTimeout(timer);
    }
  }

  async function ensureIndex() {
    if (!loadPromise) loadPromise = loadIndex().catch((e) => { loadPromise = null; throw e; });
    return loadPromise;
  }

  async function fetchForIcao(icao) {
    // v2: runway objects now carry `surface`; bump key so pre-surface cached
    // entries rebuild instead of serving the old shape.
    const cacheKey = `rw2_${(icao || "").toUpperCase()}`;
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached[cacheKey]) return cached[cacheKey];

    const idx = await ensureIndex();
    for (const id of identVariants(icao)) {
      if (idx[id]?.length) {
        const result = { ok: true, ident: id, runways: idx[id], source: "ourairports" };
        chrome.storage.local.set({ [cacheKey]: result }).catch(() => {});
        return result;
      }
    }
    return { ok: false, error: `No runways for ${icao}` };
  }

  return { fetchForIcao, identVariants };
})();
