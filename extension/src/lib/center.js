// Resolve radar center from settings — airport or arbitrary lat/lon.
window.SKCenter = (() => {
  const FALLBACK = { lat: 42.21377, lon: -83.353786, icao: "DTW", label: "DTW" };

  function parseCoord(v) {
    const n = typeof v === "string" ? parseFloat(v.trim()) : Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function validateLat(lat) {
    return lat != null && lat >= -90 && lat <= 90;
  }

  function validateLon(lon) {
    return lon != null && lon >= -180 && lon <= 180;
  }

  function formatCoords(lat, lon) {
    const ns = lat >= 0 ? "N" : "S";
    const ew = lon >= 0 ? "E" : "W";
    return `${Math.abs(lat).toFixed(2)}°${ns}, ${Math.abs(lon).toFixed(2)}°${ew}`;
  }

  function fromAirport(ap) {
    if (!ap || !Number.isFinite(ap.lat) || !Number.isFinite(ap.lon)) return null;
    return {
      lat: ap.lat,
      lon: ap.lon,
      icao: ap.icao || ap.ident || null,
      label: ap.icao || ap.ident || ap.name || "APT",
      name: ap.name || null,
      airspace: ap.airspace || null,
    };
  }

  /** Resolve center for feed + radar. lookupFn optional (SK_findAirport). */
  function resolve(cfg, lookupFn) {
    const lat = parseCoord(cfg?.centerLat);
    const lon = parseCoord(cfg?.centerLon);

    if (validateLat(lat) && validateLon(lon)) {
      const mode = cfg.centerMode === "airport" ? "airport" : "coords";
      const label =
        (cfg.centerLabel || "").trim() ||
        (mode === "airport" && cfg.icao) ||
        formatCoords(lat, lon);
      return {
        lat,
        lon,
        icao: mode === "airport" ? cfg.icao || null : null,
        label,
        name: cfg.centerName || null,
        mode,
      };
    }

    const lookup = lookupFn || window.SK_findAirport;
    if (lookup && cfg?.icao) {
      const ap = lookup(cfg.icao);
      const c = fromAirport(ap);
      if (c) return { ...c, mode: "airport" };
    }

    const fb = fromAirport(FALLBACK);
    return { ...fb, mode: "airport" };
  }

  function airportDrawObject(center, runways) {
    if (!center) return null;
    return {
      lat: center.lat,
      lon: center.lon,
      icao: center.icao || null,
      label: center.label || center.icao || "?",
      name: center.name || center.label || null,
      runways: runways || [],
    };
  }

  return {
    resolve,
    fromAirport,
    parseCoord,
    validateLat,
    validateLon,
    formatCoords,
    airportDrawObject,
    FALLBACK,
  };
})();
