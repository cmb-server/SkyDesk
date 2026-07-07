// Airport search — bundled US Class B/C fallback + background index when available.
(function () {
  const FALLBACK = [
    { icao: "DTW", ident: "KDTW", iata: "DTW", name: "Detroit Metro", lat: 42.21377, lon: -83.353786, country: "US", airspace: "B" },
    { icao: "ORD", ident: "KORD", iata: "ORD", name: "Chicago O'Hare", lat: 41.9786, lon: -87.9048, country: "US", airspace: "B" },
    { icao: "LAX", ident: "KLAX", iata: "LAX", name: "Los Angeles", lat: 33.9425, lon: -118.4081, country: "US", airspace: "B" },
    { icao: "JFK", ident: "KJFK", iata: "JFK", name: "JFK New York", lat: 40.6398, lon: -73.7789, country: "US", airspace: "B" },
    { icao: "LHR", ident: "EGLL", iata: "LHR", name: "London Heathrow", lat: 51.4706, lon: -0.4619, country: "GB", airspace: "INTL" },
  ];

  function norm(s) {
    return (s || "").trim().toUpperCase();
  }

  function localSearch(q, limit) {
    const s = norm(q);
    if (!s) return FALLBACK.slice(0, limit);
    return FALLBACK.filter(
      (a) =>
        a.icao.includes(s) ||
        (a.iata && a.iata.includes(s)) ||
        a.name.toUpperCase().includes(s)
    ).slice(0, limit);
  }

  function msgSearch(q, limit, cb) {
    if (!chrome.runtime?.id) {
      cb(localSearch(q, limit));
      return;
    }
    chrome.runtime.sendMessage({ type: "search-airports", query: q, limit }, (res) => {
      void chrome.runtime.lastError;
      cb(res?.ok && res.results?.length ? res.results : localSearch(q, limit));
    });
  }

  function msgGet(icao, cb) {
    if (!chrome.runtime?.id) {
      const s = norm(icao);
      cb(FALLBACK.find((a) => a.icao === s || a.iata === s) || null);
      return;
    }
    chrome.runtime.sendMessage({ type: "get-airport", icao }, (res) => {
      void chrome.runtime.lastError;
      if (res?.ok && res.airport) cb(res.airport);
      else {
        const s = norm(icao);
        cb(FALLBACK.find((a) => a.icao === s || a.iata === s) || null);
      }
    });
  }

  window.SK_findAirport = function (q) {
    const s = norm(q);
    if (!s) return null;
    return (
      FALLBACK.find((a) => a.icao === s || a.iata === s) ||
      FALLBACK.find((a) => a.name.toUpperCase().includes(s)) ||
      null
    );
  };

  window.SK_searchAirports = function (q) {
    return localSearch(q, 12);
  };

  window.SK_searchAirportsAsync = function (q, limit, cb) {
    msgSearch(q, limit || 12, cb);
  };

  window.SK_getAirportAsync = function (icao, cb) {
    msgGet(icao, cb);
  };

  window.SK_AIRPORTS = FALLBACK;
})();
