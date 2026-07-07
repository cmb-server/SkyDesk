// Airport index — US Class B/C (bundled) + international major/regional airports (OurAirports).
const SKAirportsLoad = (() => {
  const CSV_URL =
    "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv";
  const BUNDLED_URL = chrome.runtime.getURL("src/data/us-class-bc.json");
  // Bumped to v2 when the international pull broadened to medium_airport and added
  // the "INTL-R" regional tier, so any stale v1 cache is rebuilt.
  const CACHE_KEY = "apt_index_v2";

  let index = null;
  let loadPromise = null;

  function norm(s) {
    return (s || "").trim().toUpperCase();
  }

  function toEntry(row) {
    const ident = norm(row.ident || row.icao);
    const icao =
      ident.startsWith("K") && ident.length === 4
        ? ident.slice(1)
        : norm(row.icao) || ident;
    const lat = Number(row.lat ?? row.latitude_deg);
    const lon = Number(row.lon ?? row.longitude_deg);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return {
      icao,
      ident: ident || (row.country === "US" ? `K${icao}` : icao),
      iata: (row.iata || "").trim(),
      name: row.name || icao,
      lat,
      lon,
      country: row.country || row.iso_country || "",
      airspace: row.airspace || null,
    };
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

  function mergeEntry(map, entry) {
    if (!entry) return;
    const key = entry.icao || entry.ident;
    if (!key) return;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, entry);
      return;
    }
    // Curated bundled entries (US Class B/C) are loaded first; never let a broader
    // international row overwrite their fields or downgrade their airspace tier.
    const merged = { ...entry, ...prev };
    merged.airspace = prev.airspace || entry.airspace;
    map.set(key, merged);
  }

  async function loadBundled() {
    const r = await fetch(BUNDLED_URL, { cache: "force-cache" });
    if (!r.ok) throw new Error(`Bundled airports HTTP ${r.status}`);
    const list = await r.json();
    return Array.isArray(list) ? list : [];
  }

  async function loadInternational() {
    const r = await fetch(CSV_URL, { cache: "default" });
    if (!r.ok) throw new Error(`Airports CSV HTTP ${r.status}`);
    const lines = (await r.text()).split(/\r?\n/);
    const out = [];
    for (let i = 1; i < lines.length; i++) {
      const f = parseCsvLine(lines[i]);
      if (!f[1]) continue;
      const type = f[2];
      const country = f[8];
      const scheduled = f[11];
      // Tier by OurAirports type (the correct global signal): large -> major,
      // medium -> regional. "Class B/C" is FAA-only and stays US-bundled.
      let airspace = null;
      if (type === "large_airport") airspace = "INTL";
      else if (type === "medium_airport") airspace = "INTL-R";
      else continue;
      if (scheduled !== "yes") continue;
      if (country === "US") continue;
      const entry = toEntry({
        ident: f[1],
        name: f[3],
        lat: f[4],
        lon: f[5],
        country,
        iata: f[13],
        airspace,
      });
      if (entry) out.push(entry);
    }
    return out;
  }

  async function buildIndex() {
    const map = new Map();
    const bundled = await loadBundled();
    for (const row of bundled) mergeEntry(map, toEntry(row));

    try {
      const intl = await loadInternational();
      for (const row of intl) mergeEntry(map, row);
    } catch (e) {
      console.warn("[SkyDesk] International airport load failed:", e);
    }

    index = [...map.values()].sort((a, b) => a.icao.localeCompare(b.icao));
    chrome.storage.local.set({ [CACHE_KEY]: index }).catch(() => {});
    return index;
  }

  async function ensureIndex() {
    if (index) return index;

    const cached = await chrome.storage.local.get(CACHE_KEY);
    if (cached[CACHE_KEY]?.length) {
      index = cached[CACHE_KEY];
      return index;
    }

    if (!loadPromise) {
      loadPromise = buildIndex().catch((e) => {
        loadPromise = null;
        throw e;
      });
    }
    return loadPromise;
  }

  function score(entry, q) {
    const icao = norm(entry.icao);
    const ident = norm(entry.ident);
    const iata = norm(entry.iata);
    const name = norm(entry.name);
    if (icao === q || ident === q || iata === q) return 100;
    if (icao.startsWith(q) || ident.startsWith(q) || iata.startsWith(q)) return 80;
    if (name.startsWith(q)) return 60;
    if (icao.includes(q) || ident.includes(q) || iata.includes(q)) return 40;
    if (name.includes(q)) return 30;
    return 0;
  }

  async function search(query, limit = 16) {
    const q = norm(query);
    const idx = await ensureIndex();
    if (!q) return idx.slice(0, limit);
    return idx
      .map((a) => ({ a, s: score(a, q) }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s || x.a.icao.localeCompare(y.a.icao))
      .slice(0, limit)
      .map((x) => x.a);
  }

  async function getByIcao(icao) {
    const q = norm(icao);
    if (!q) return null;
    const idx = await ensureIndex();
    return (
      idx.find((a) => norm(a.icao) === q || norm(a.ident) === q || norm(a.iata) === q) || null
    );
  }

  return { ensureIndex, search, getByIcao };
})();
