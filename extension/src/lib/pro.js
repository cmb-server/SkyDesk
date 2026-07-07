// SkyDesk advanced layers — entitlement-aware feature metadata.
window.SKPro = (() => {
  const SKEnt = window.SKEntitlement;

  const FEATURES = {
    flightTrack: {
      key: "proFlightTrack",
      label: "Flight track",
      hint: "Shift+click a plane for route, origin, and destination.",
      requiresAirport: false,
    },
    flightTracker: {
      key: "viewMode",
      label: "Flight Tracker",
      hint: "Track any flight number on a world map: origin, destination, planned route, and live position.",
      requiresAirport: false,
      cfgValue: "tracker",
    },
    groundMode: {
      key: "proGroundMode",
      label: "Airport ground mode",
      hint: "Fullscreen airfield zoom with OSM terminal footprints, ground traffic up to 150 kt.",
      requiresAirport: true,
    },
    weather: {
      key: "showWeather",
      label: "Weather radar",
      hint: "Precipitation and storm cells around the selected airport.",
      requiresAirport: false,
    },
    terrain: {
      key: "showTerrain",
      label: "Terrain map",
      hint: "Elevation shading and obstacles near the airfield.",
      requiresAirport: false,
    },
    water: {
      key: "showWater",
      label: "Water",
      hint: "Ocean and lake polygons under the radar.",
      requiresAirport: false,
    },
    emergency: {
      key: "showEmergency",
      label: "Emergency squawks",
      hint: "Highlight 7500, 7600, and 7700 squawk codes.",
      requiresAirport: false,
    },
    coordsWatch: {
      key: "centerMode",
      label: "Watch latitude / longitude",
      hint: "Center the radar on any coordinates or your current location.",
      requiresAirport: false,
      cfgValue: "coords",
    },
    backgroundDisplay: {
      key: "displayMode",
      label: "Full background",
      hint: "Semi-transparent radar over the whole page.",
      requiresAirport: false,
      cfgValue: "background",
    },
  };

  const FEATURE_BY_CFG = {};
  for (const [id, f] of Object.entries(FEATURES)) {
    FEATURE_BY_CFG[f.key] = id;
  }

  function entitled(state) {
    return SKEnt ? SKEnt.isActive(state) : true;
  }

  function canUseCoordsMode(state) {
    return SKEnt ? SKEnt.canUseCoordsMode(state) : true;
  }

  function canUseBackgroundMode(state) {
    return SKEnt ? SKEnt.canUseBackgroundMode(state) : true;
  }

  function canUseTrackMode(state) {
    return SKEnt ? SKEnt.canUseTrackMode(state) : true;
  }

  function featureIdForCfgKey(key) {
    return FEATURE_BY_CFG[key] || null;
  }

  function isFeatureEnabled(id, cfg, state) {
    if (!entitled(state)) return false;
    const f = FEATURES[id];
    if (!f) return false;
    if (id === "flightTrack") return !!cfg?.proFlightTrack;
    if (id === "flightTracker") return cfg?.viewMode === "tracker" || false;
    if (id === "groundMode") {
      return !!(cfg?.proGroundMode && cfg?.centerMode === "airport" && cfg?.icao);
    }
    if (id === "weather") return !!cfg?.showWeather;
    if (id === "terrain") return !!cfg?.showTerrain;
    if (id === "water") return !!cfg?.showWater;
    if (id === "emergency") return cfg?.showEmergency !== false;
    return false;
  }

  function isEnabled(cfg, state) {
    return (
      isFeatureEnabled("flightTrack", cfg, state) ||
      isFeatureEnabled("groundMode", cfg, state) ||
      isFeatureEnabled("flightTracker", cfg, state)
    );
  }

  function canShowAirportLayers(cfg) {
    return cfg?.centerMode === "airport" && !!(cfg?.icao || "").trim();
  }

  function effectiveCfg(cfg, state) {
    if (entitled(state) || !SKEnt) return cfg;
    return SKEnt.stripGatedCfg(cfg, false);
  }

  function updateProBlock(blockEl, cfg) {
    if (!blockEl) return;
    const show = canShowAirportLayers(cfg);
    blockEl.classList.toggle("hidden", !show);
  }

  return {
    FEATURES,
    entitled,
    canUseCoordsMode,
    canUseBackgroundMode,
    canUseTrackMode,
    featureIdForCfgKey,
    isEnabled,
    isFeatureEnabled,
    canShowAirportLayers,
    effectiveCfg,
    updateProBlock,
  };
})();
