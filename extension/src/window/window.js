(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $("hud");
  const ctx = canvas?.getContext("2d") || null;

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  const EXT_RELOAD_MSG = "Refresh page — SkyDesk was updated";
  let extContextLost = false;
  let entitleRefreshInterval = null;

  function isExtensionContextValid() {
    try {
      return !!chrome.runtime?.id;
    } catch (_) {
      return false;
    }
  }

  function isContextInvalidatedError(err) {
    const msg = String(err?.message || err || "");
    return msg.includes("Extension context invalidated") || msg.includes("context invalidated");
  }

  function safeSendMessage(msg) {
    if (!isExtensionContextValid()) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        if (!chrome.runtime?.sendMessage) return resolve(null);
        chrome.runtime.sendMessage(msg, (res) => {
          drainRuntimeLastError();
          resolve(res ?? null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function drainRuntimeLastError() {
    try {
      void chrome.runtime?.lastError;
    } catch (_) {}
  }

  function runtimeLastError() {
    try {
      return chrome.runtime?.lastError ?? null;
    } catch (_) {
      return { message: "Extension context invalidated" };
    }
  }

  function windowActive() {
    return !extContextLost && isExtensionContextValid();
  }

  function haltWindowActivity() {
    if (extContextLost) return false;
    extContextLost = true;
    clearTimeout(refreshTimer);
    refreshTimer = null;
    clearTimeout(fetchWatchdog);
    fetchWatchdog = null;
    clearTimeout(cfgCommitTimer);
    cfgCommitTimer = null;
    clearInterval(trackPoll);
    trackPoll = null;
    clearInterval(trackPulse);
    trackPulse = null;
    clearInterval(tailWatchPoll);
    tailWatchPoll = null;
    clearInterval(entitleRefreshInterval);
    entitleRefreshInterval = null;
    if (animId != null) {
      cancelAnimationFrame(animId);
      animId = null;
    }
    return true;
  }

  function showExtensionReloadStatus() {
    if (!haltWindowActivity()) return;
    const status = $("subStatus");
    if (status) status.textContent = EXT_RELOAD_MSG;
  }

  function handleContextError(err) {
    try {
      if (isContextInvalidatedError(err)) showExtensionReloadStatus();
    } catch (_) {}
  }

  window.addEventListener("unhandledrejection", (event) => {
    if (!isContextInvalidatedError(event.reason)) return;
    event.preventDefault();
    handleContextError(event.reason);
  });

  function setStatus(msg) {
    const el = $("status");
    if (el) el.textContent = msg;
  }

  function setText(id, msg) {
    const el = $(id);
    if (el) el.textContent = msg;
  }

  const DEFAULTS = {
    enabled: true,
    overlay: true,
    centerMode: "airport",
    icao: "DTW",
    centerLat: 42.21377,
    centerLon: -83.353786,
    centerLabel: "DTW",
    rangeNm: 40,
    opacity: 55,
    heading: 0,
    refreshSec: 2,
    showAirlines: true,
    showGa: true,
    showMilitary: true,
    showEmergency: true,
    showAltitude: false,
    showSpeed: false,
    showType: false,
    blipStyle: "plane",
    tagFontSize: 9,
    showTagBg: true,
    showSweep: false,
    showWeather: false,
    weatherOpacity: 70,
    showTerrain: false,
    terrainOpacity: 60,
    showWater: false,
    waterOpacity: 70,
    showAirportDot: true,
    showHomeMarker: false,
    showOverheadHighlight: true,
    homeMarkerColor: "#ffb84d",
    homeMarkerOpacity: 90,
    viewMode: "radar",
    trackFlight: "",
    trackTail: "",
    trackKind: "flight",
    tailWatch: false,
    trackerOpacity: 75,
    proFlightTrack: true,
    proGroundMode: false,
    groundRangeNm: 2.5,
    hideUnder80Kts: false,
    showRangeRings: true,
    showOuterRing: true,
    showRunways: true,
    ringOpacity: 100,
    colorPlane: "#66ff99",
    colorMilitary: "#ffcc55",
    colorTag: "#55ee88",
    colorTagBg: "#d0d0d0",
    colorAirport: "#4dff7a",
    colorRings: "#2a8a42",
    colorRunway: "#b8ffc8",
    settingsPanelCollapsed: false,
  };

  let cfg = { ...DEFAULTS };
  let center = null;
  let aircraft = [];
  let selected = null;
  let selectedKey = null;
  let routeInfo = undefined;
  let lastDrawList = [];
  let lastDrawW = 0;
  let lastDrawH = 0;
  let refreshTimer = null;
  let pageHidden = typeof document !== "undefined" ? document.hidden : false;
  let fetchStartedAt = 0;
  let sweepAngle = 0;
  let animId = null;
  let runways = [];
  let runwayReq = 0;
  let terminals = [];
  let terminalReq = 0;
  let airportInfo = null;
  let airportInfoReq = 0;
  let entitlement = { active: false, ok: false };
  let controlsBound = false;
  let pendingSource = null;
  // Feed watchdog — mirrors overlay.js so a stuck fetch can't hang the tab on
  // "Scanning…" forever; the watchdog aborts the wait and reschedules.
  const FETCH_WATCHDOG_MS = 18000;
  let fetchReq = 0;
  let fetchWatchdog = null;

  // Fail CLOSED if entitlement.js failed to load — an unverifiable entitlement
  // must not silently unlock paid features (SKEntitlement is normally always
  // present, loaded just before this script).
  function isEntitled() {
    return window.SKEntitlement ? SKEntitlement.isActive(entitlement) : false;
  }

  function canUseCoordsMode() {
    return window.SKEntitlement ? SKEntitlement.canUseCoordsMode(entitlement) : false;
  }

  function canUseTrackMode() {
    return window.SKEntitlement ? SKEntitlement.canUseTrackMode(entitlement) : false;
  }

  function effectiveCfg() {
    if (!window.SKEntitlement) return cfg;
    return SKEntitlement.stripGatedCfg(cfg, isEntitled());
  }

  function isGroundActive() {
    return window.SKRadar?.isGroundMode?.(cfg) ?? false;
  }

  function fetchRangeNm() {
    return isGroundActive() ? cfg.groundRangeNm || 2.5 : cfg.rangeNm;
  }

  function canUseGroundMode() {
    return cfg.centerMode === "airport" && !!(cfg.icao || "").trim();
  }

  function trackKind() {
    return cfg.trackKind === "tail" ? "tail" : "flight";
  }

  function headingLabel(deg) {
    return SKRadar.COMPASS[Math.round(deg / 45) % 8];
  }

  function refreshEntitlement() {
    if (!windowActive()) {
      if (!isExtensionContextValid()) showExtensionReloadStatus();
      return Promise.resolve(entitlement);
    }
    return safeSendMessage({ type: "get-entitlement" })
      .then((res) => {
        if (!windowActive()) {
          showExtensionReloadStatus();
          return entitlement;
        }
        try {
          entitlement = res && res.ok !== false ? res : { active: false, ok: false };
          syncSubscriptionUI();
          enforceEntitlement();
        } catch (e) {
          handleContextError(e);
        }
        return entitlement;
      })
      .catch((e) => {
        handleContextError(e);
        return entitlement;
      });
  }

  async function requireEntitlement() {
    try {
      if (!isExtensionContextValid()) {
        showExtensionReloadStatus();
        return false;
      }
      if (isEntitled()) return true;
      await refreshEntitlement();
      if (!isExtensionContextValid()) {
        showExtensionReloadStatus();
        return false;
      }
      if (isEntitled()) return true;
      if (!entitlement.trialStartedAt) {
        if (!isExtensionContextValid()) {
          showExtensionReloadStatus();
          return false;
        }
        const trialRes = await safeSendMessage({ type: "open-trial" });
        if (trialRes?.localTrial && trialRes?.state) {
          entitlement = trialRes.state;
          syncSubscriptionUI();
          enforceEntitlement();
          if (isEntitled()) return true;
        }
      } else {
        await safeSendMessage({ type: "open-subscription" });
      }
      syncSubscriptionUI();
      return false;
    } catch (e) {
      if (isContextInvalidatedError(e)) {
        showExtensionReloadStatus();
        return false;
      }
      console.warn("[SkyDesk window] requireEntitlement:", e);
      return false;
    }
  }

  function syncSubscriptionUI() {
    const status = $("subStatus");
    if (status && window.SKEntitlement) {
      status.textContent = SKEntitlement.statusLabel(entitlement);
    }
    const trialBtn = $("trialBtn");
    const subBtn = $("subBtn");
    if (trialBtn) trialBtn.classList.toggle("hidden", isEntitled() || !!entitlement.trialStartedAt);
    if (subBtn) {
      subBtn.textContent = entitlement.paid ? "Manage subscription" : "Subscribe · $2.99/mo or $24.99/yr";
    }
  }

  function showGateFeedback(feature) {
    const status = $("subStatus");
    if (!status) return;
    const trialAvail = !entitlement.trialStartedAt;
    if (feature === "coords" || feature === "location") {
      status.textContent = trialAvail
        ? "7-day free trial includes location watch and background mode"
        : "Subscribe to watch planes at your location";
      return;
    }
    if (feature === "track") {
      status.textContent = trialAvail
        ? "7-day free trial includes flight tracking"
        : "Subscribe to track flights and tail numbers";
      return;
    }
    status.textContent = trialAvail
      ? "Start your 7-day free trial to unlock route path on radar"
      : "Subscribe to unlock route path on radar";
  }

  function syncEntitlementControls() {
    const coordsOk = canUseCoordsMode();
    const trackOk = canUseTrackMode();
    document.querySelectorAll('input[name="centerMode"]').forEach((r) => {
      const row = r.closest("label");
      const locked = r.value === "coords" ? !coordsOk : r.value === "track" ? !trackOk : false;
      if (row) row.classList.toggle("gated-locked", locked);
      // Keep radios clickable so requireEntitlement() can start local trial / show gate feedback.
    });
    const coordsBlock = $("coordsBlock");
    if (coordsBlock) {
      const locked = !coordsOk && sourceMode() !== "coords";
      coordsBlock.classList.toggle("gated-locked", locked);
      coordsBlock.querySelectorAll("input, button").forEach((el) => {
        el.disabled = locked;
      });
    }
    const trackBlock = $("trackBlock");
    if (trackBlock) {
      const locked = !trackOk && sourceMode() !== "track";
      trackBlock.classList.toggle("gated-locked", locked);
      trackBlock.querySelectorAll("input, button").forEach((el) => {
        if (el.type !== "radio" || el.name !== "trackKind") el.disabled = locked;
      });
    }
    $("coordsGateHint")?.classList.toggle("hidden", coordsOk);
    $("trackGateHint")?.classList.toggle("hidden", trackOk);
  }

  function syncGatedControls() {
    const drawCfg = effectiveCfg();
    for (const key of SKEntitlement?.GATED_CFG_KEYS || []) {
      if (!(key in cfg)) continue;
      const el = $(key);
      if (el && el.type === "checkbox") el.checked = !!drawCfg[key];
    }
  }

  function syncGroundControls() {
    const row = $("groundModeRow");
    const inp = $("proGroundMode");
    const on = canUseGroundMode();
    if (row) row.classList.toggle("gated-locked", !on);
    if (inp) {
      inp.disabled = !on;
      if (!on) inp.checked = false;
    }
  }

  function syncHomeMarkerControls() {
    const on = sourceMode() === "coords";
    const block = $("homeMarkerBlock");
    if (block) {
      block.classList.toggle("gated-locked", !on);
      block.querySelectorAll("input").forEach((inp) => {
        inp.disabled = !on;
      });
    }
    const hint = $("homeMarkerHint");
    if (hint) hint.textContent = on ? "(watch center)" : "(lat/long only)";
  }

  function enforceEntitlement() {
    if (isEntitled()) {
      syncEntitlementControls();
      syncGroundControls();
      return;
    }
    const stripped = effectiveCfg();
    const patch = {};
    const keys = new Set([
      ...(window.SKEntitlement?.GATED_CFG_KEYS || []),
      "centerMode",
      "viewMode",
      "trackFlight",
      "trackTail",
      "tailWatch",
      "icao",
      "centerLat",
      "centerLon",
      "centerLabel",
    ]);
    for (const key of keys) {
      if (key in cfg && cfg[key] !== stripped[key]) {
        patch[key] = stripped[key];
        cfg[key] = stripped[key];
      }
    }
    syncGatedControls();
    if ((trackMode || tailWatch || cfg.viewMode === "tracker" || cfg.tailWatch) && !isEntitled()) {
      clearTrack({ keepCfg: false });
    }
    if (Object.keys(patch).length && chrome.storage?.sync) {
      chrome.storage.sync.set(patch);
      syncCenter();
      draw();
    }
    syncEntitlementControls();
    syncGroundControls();
  }

  function gateCfgToggle(key, val, finish) {
    const needsEntitlement = window.SKEntitlement?.cfgValueRequiresEntitlement(key, val);
    if (needsEntitlement && !isEntitled()) {
      requireEntitlement().then((ok) => {
        const el = $(key);
        if (!ok) {
          if (el?.type === "checkbox") el.checked = false;
          return;
        }
        finish();
      }).catch(handleContextError);
      return;
    }
    finish();
  }

  function saveCfg(patch) {
    Object.assign(cfg, patch);
    if (chrome.storage?.sync) chrome.storage.sync.set(patch);
  }

  let cfgCommitTimer = null;
  let cfgPending = {};

  function flushPendingCfg() {
    cfgCommitTimer = null;
    if (!chrome.storage?.sync || !Object.keys(cfgPending).length) return;
    const patch = { ...cfgPending };
    cfgPending = {};
    chrome.storage.sync.set(patch);
  }

  function queueCfgPatch(patch) {
    Object.assign(cfgPending, patch);
    clearTimeout(cfgCommitTimer);
    cfgCommitTimer = setTimeout(flushPendingCfg, 350);
  }

  function setSettingsPanelCollapsed(collapsed, persist = true) {
    cfg.settingsPanelCollapsed = !!collapsed;
    $("panel")?.classList.toggle("collapsed", cfg.settingsPanelCollapsed);
    $("settingsPanelExpand")?.classList.toggle("hidden", !cfg.settingsPanelCollapsed);
    if (persist) saveCfg({ settingsPanelCollapsed: cfg.settingsPanelCollapsed });
    draw();
  }

  // --- Flight tracking ---
  const TRACK_POLL_MS = 12000;
  const TRACK_PULSE_MS = 130;
  const TRACK_TRAIL_CAP = 800;
  const TRACK_TRAIL_MIN_NM = 0.5;
  const TRACK_MAX_AGE_MS = 6 * 60 * 60 * 1000;
  let trackMode = false;
  let trackBusy = false;
  let tailWatch = false;
  let tailWatchPoll = null;
  let worldReady = false;
  let trackModel = { dep: null, arr: null, live: null, planned: [], actual: [] };
  let trackStamps = [];
  let trackKey = null;
  let trackPoll = null;
  let trackPulse = null;
  let trackStatusText = "";

  function setSourceMode(mode) {
    const airport = mode === "airport";
    const coords = mode === "coords";
    const track = mode === "track";
    $("airportBlock")?.classList.toggle("hidden", !airport);
    $("coordsBlock")?.classList.toggle("hidden", !coords);
    $("trackBlock")?.classList.toggle("hidden", !track);
    document.querySelectorAll('input[name="centerMode"]').forEach((el) => {
      el.checked = el.value === mode;
    });
    syncHomeMarkerControls();
  }

  function sourceMode() {
    if (trackMode || cfg.viewMode === "tracker" || tailWatch || cfg.tailWatch) return "track";
    if (pendingSource) return pendingSource;
    return cfg.centerMode === "coords" ? "coords" : "airport";
  }

  function syncTrackUI() {
    const kind = trackKind();
    document.querySelectorAll('input[name="trackKind"]').forEach((r) => {
      if (r !== document.activeElement) r.checked = r.value === kind;
    });
    $("trackFlightField")?.classList.toggle("hidden", kind !== "flight");
    $("trackTailField")?.classList.toggle("hidden", kind !== "tail");

    const flightIn = $("flightInput");
    const tailIn = $("tailInput");
    if (flightIn && flightIn !== document.activeElement && cfg.trackFlight) {
      flightIn.value = cfg.trackFlight;
    }
    if (tailIn && tailIn !== document.activeElement && cfg.trackTail) {
      tailIn.value = cfg.trackTail;
    }

    const active = trackMode || tailWatch || cfg.tailWatch;
    const btn = $("trackBtn");
    if (btn) btn.textContent = active ? "Retrack" : "Track";
    $("clearTrack")?.classList.toggle("hidden", !active);
  }

  function badge(ap) {
    if (ap.airspace === "B") return "B";
    if (ap.airspace === "C") return "C";
    if (ap.airspace === "INTL") return "INTL";
    if (ap.airspace === "INTL-R") return "REG";
    return "";
  }

  function syncCenter() {
    if (!window.SKCenter?.resolve) {
      center = null;
      return;
    }
    try {
      center = SKCenter.resolve(cfg, SK_findAirport);
      if (
        center &&
        (center.lat == null ||
          center.lon == null ||
          !Number.isFinite(Number(center.lat)) ||
          !Number.isFinite(Number(center.lon)))
      ) {
        center = null;
      }
    } catch (e) {
      console.warn("[SkyDesk window] syncCenter:", e);
      center = null;
    }
    const label = $("airportLabel");
    if (label) label.textContent = center?.label || center?.icao || "Radar";
  }

  function airportForDraw() {
    if (!center || cfg.centerMode !== "airport" || !cfg.icao) return null;
    const apt = SKCenter.airportDrawObject(
      { ...center, label: center.label || center.icao },
      runways
    );
    // Ground mode draws terminal footprints + airport info, matching overlay.js.
    if (apt && isGroundActive()) {
      apt.terminals = terminals;
      apt.info = airportInfo;
    }
    return apt;
  }

  function loadRunways() {
    if (!isExtensionContextValid()) return;
    if (cfg.centerMode !== "airport" || !cfg.icao) {
      runways = [];
      terminals = [];
      airportInfo = null;
      draw();
      return;
    }
    const icao = cfg.icao;
    runways = [];
    draw();
    const req = ++runwayReq;
    try {
      chrome.runtime.sendMessage({ type: "fetch-runways", icao }, (res) => {
        drainRuntimeLastError();
        if (req !== runwayReq || cfg.icao !== icao || cfg.centerMode !== "airport") return;
        runways = res?.ok ? res.runways : [];
        draw();
      });
    } catch (e) {
      if (isContextInvalidatedError(e)) showExtensionReloadStatus();
    }
    loadTerminals();
    loadAirportInfo();
  }

  function loadTerminals() {
    if (!isExtensionContextValid()) return;
    syncCenter();
    if (cfg.centerMode !== "airport" || !cfg.icao || !center) {
      terminals = [];
      draw();
      return;
    }
    const icao = cfg.icao;
    const lat = center.lat;
    const lon = center.lon;
    terminals = [];
    draw();
    const req = ++terminalReq;
    try {
      chrome.runtime.sendMessage({ type: "fetch-terminals", icao, lat, lon }, (res) => {
        drainRuntimeLastError();
        if (req !== terminalReq || cfg.icao !== icao || cfg.centerMode !== "airport") return;
        terminals = res?.ok ? res.terminals : [];
        draw();
      });
    } catch (e) {
      if (isContextInvalidatedError(e)) showExtensionReloadStatus();
    }
  }

  function loadAirportInfo() {
    if (!isExtensionContextValid()) return;
    if (cfg.centerMode !== "airport" || !cfg.icao) {
      airportInfo = null;
      return;
    }
    const icao = cfg.icao;
    airportInfo = null;
    const req = ++airportInfoReq;
    try {
      chrome.runtime.sendMessage({ type: "fetch-airport-info", icao }, (res) => {
        drainRuntimeLastError();
        if (req !== airportInfoReq || cfg.icao !== icao || cfg.centerMode !== "airport") return;
        airportInfo = res?.ok ? res.info : null;
        draw();
      });
    } catch (e) {
      if (isContextInvalidatedError(e)) showExtensionReloadStatus();
    }
  }

  function radarDrawOpts() {
    const c = effectiveCfg();
    const ground = isGroundActive();
    const range = fetchRangeNm();
    return {
      ...c,
      rangeNm: range,
      mode: "background",
      fillBg: true,
      showLabels: true,
      maxBlips: ground ? 128 : 96,
      sweepAngle: ground ? null : c.showSweep ? sweepAngle : null,
      showSweep: ground ? false : c.showSweep,
      onLayerReady: draw,
    };
  }

  function applyTrackerOpacity() {
    if (!canvas) return;
    // Tracker opacity now drives the world-map backdrop alpha inside draw(), so
    // the live aircraft and route stay fully opaque. Clear any legacy element
    // opacity and repaint so the new backdrop value takes effect.
    canvas.style.opacity = "";
    if (trackMode) draw();
  }

  function resize() {
    if (!canvas || !ctx) return;
    canvas.width = innerWidth * devicePixelRatio;
    canvas.height = innerHeight * devicePixelRatio;
    canvas.style.width = innerWidth + "px";
    canvas.style.height = innerHeight + "px";
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    draw();
  }

  function flightPathTrackActive() {
    return effectiveCfg().proFlightTrack;
  }

  function shiftFlightPickEnabled() {
    return !isEntitled() || cfg.proFlightTrack;
  }

  function updateSelectedCard() {
    const el = $("selected");
    if (!el) return;
    if (!selected) {
      el.classList.add("hidden");
      return;
    }
    const info = SKRadar.formatFlightCard(selected, routeInfo);
    const emg = effectiveCfg().showEmergency !== false ? SKRadar.emergencyInfo(selected) : null;
    const emgLine = emg
      ? `<br><span style="color:#ff8866">⚠ ${esc(emg.label)}${emg.code && emg.code !== "EMG" ? ` · SQ ${esc(emg.code)}` : ""}</span>`
      : "";
    const pathGated = cfg.proFlightTrack && !flightPathTrackActive();
    const footer = pathGated
      ? "Route path on radar requires subscription · Shift+click to clear"
      : "Shift+click same plane or empty sky to clear";
    el.classList.remove("hidden");
    el.innerHTML = `<strong>${esc(info.title)}</strong>${emgLine}<br>${info.lines.map(esc).join("<br>")}<br><em>${esc(footer)}</em>`;
  }

  function clearFlightSelection() {
    selected = null;
    selectedKey = null;
    routeInfo = undefined;
    updateSelectedCard();
    draw();
  }

  function fetchRouteFor(ac) {
    if (!isExtensionContextValid() || !ac) return;
    const key = SKRadar.acKey(ac);
    routeInfo = null;
    updateSelectedCard();
    try {
      chrome.runtime.sendMessage(
        {
          type: "fetch-flight-route",
          callsign: ac.flight || ac.r,
          lat: ac.lat,
          lon: ac.lon,
        },
        (res) => {
          drainRuntimeLastError();
          if (selectedKey !== key) return;
          routeInfo = res?.ok ? res.route : false;
          updateSelectedCard();
          draw();
        }
      );
    } catch (e) {
      if (isContextInvalidatedError(e)) showExtensionReloadStatus();
    }
  }

  function draw() {
    if (!windowActive()) {
      if (!isExtensionContextValid()) showExtensionReloadStatus();
      return;
    }
    if (!ctx) return;
    try {
      if (trackMode) {
        if (worldReady && window.SKWorldMap) {
          // Tracker opacity drives the base-map backdrop alpha; the route and the
          // live aircraft stay fully opaque on top.
          SKWorldMap.draw(ctx, innerWidth, innerHeight, trackModel, performance.now(), {
            backdropAlpha: Math.min(1, (cfg.trackerOpacity ?? 75) / 100),
          });
        }
        if (trackStatusText) setStatus(trackStatusText);
        return;
      }

      if (!window.SKRadar?.draw) return;
      const opts = radarDrawOpts();
      const list = SKRadar.draw(
        ctx,
        innerWidth,
        innerHeight,
        opts,
        airportForDraw(),
        aircraft,
        selected,
        routeInfo
      );
      lastDrawList = list;
      lastDrawW = innerWidth;
      lastDrawH = innerHeight;

      const emgCount = effectiveCfg().showEmergency !== false
        ? list.reduce((n, a) => n + (SKRadar.emergencyInfo(a) ? 1 : 0), 0)
        : 0;
      const gnd = isGroundActive() ? " · GND" : "";
      const emg = emgCount > 0 ? ` · ⚠${emgCount}` : "";
      const lbl = center?.label || center?.icao || "Radar";
      setStatus(`${list.length} aircraft${emg}${gnd} · ${lbl} · ${fetchRangeNm()} nm`);
      applyTrackerOpacity();
    } catch (e) {
      console.warn("[SkyDesk window] draw:", e);
    }
  }

  // --- Flight tracking helpers ---
  function getAirportAsync(icao) {
    return new Promise((resolve) => {
      if (!icao || typeof SK_getAirportAsync !== "function") return resolve(null);
      SK_getAirportAsync(icao, resolve);
    });
  }

  async function resolveTrackCoords(ap) {
    if (!ap) return null;
    if (ap.lat != null && ap.lon != null) return ap;
    const found = await getAirportAsync(ap.icao || ap.iata);
    if (found) return { ...ap, lat: found.lat, lon: found.lon, name: ap.name || found.name };
    return ap.lat != null ? ap : null;
  }

  function buildTrackPlanned() {
    const { dep, arr } = trackModel;
    if (dep && arr && dep.lat != null && arr.lat != null && window.SKGeo) {
      trackModel.planned = SKGeo.interpolateGreatCircle(dep.lat, dep.lon, arr.lat, arr.lon, 120);
    } else {
      trackModel.planned = [];
    }
  }

  function loadTrackTrail(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (s) => {
        const raw = Array.isArray(s[key]) ? s[key] : [];
        const cutoff = Date.now() - TRACK_MAX_AGE_MS;
        const pts = [];
        const ts = [];
        for (const e of raw) {
          if (!Array.isArray(e) || e.length < 3) continue;
          const [t, lon, lat] = e;
          if (typeof t === "number" && t < cutoff) continue;
          pts.push([lon, lat]);
          ts.push(typeof t === "number" ? t : Date.now());
        }
        resolve({ pts, ts });
      });
    });
  }

  function saveTrackTrail() {
    if (!trackKey) return;
    const raw = trackModel.actual
      .map(([lon, lat], i) => [trackStamps[i] ?? Date.now(), lon, lat])
      .slice(-TRACK_TRAIL_CAP);
    chrome.storage.local.set({ [trackKey]: raw });
  }

  function appendTrackTrail(live) {
    if (!live || live.lat == null) return;
    const last = trackModel.actual[trackModel.actual.length - 1];
    if (last && window.SKGeo) {
      const d = SKGeo.nmDistance(last[1], last[0], live.lat, live.lon);
      if (d < TRACK_TRAIL_MIN_NM) return;
    }
    trackModel.actual.push([live.lon, live.lat]);
    trackStamps.push(Date.now());
    if (trackModel.actual.length > TRACK_TRAIL_CAP) {
      trackModel.actual = trackModel.actual.slice(-TRACK_TRAIL_CAP);
      trackStamps = trackStamps.slice(-TRACK_TRAIL_CAP);
    }
    saveTrackTrail();
  }

  // Seed the flown path from the aircraft's recorded ADS-B trace (same
  // fetch-flight-trace data the corner-widget route path uses) so engaging a
  // flight already in the air shows its real prior track, not just the trail
  // recorded since tracking started. Only runs for a fresh track so it never
  // clobbers points already accumulated live.
  function seedTrackFromTrace(hex, key) {
    if (!hex || !isExtensionContextValid()) return;
    if (trackModel.actual.length > 2) return;
    try {
      chrome.runtime.sendMessage({ type: "fetch-flight-trace", hex, recent: true }, (tr) => {
        drainRuntimeLastError();
        if (!trackMode || trackKey !== key) return;
        if (trackModel.actual.length > 2) return;
        const pts = tr?.ok && Array.isArray(tr.trace?.points) ? tr.trace.points : null;
        if (!pts || pts.length < 2) return;
        const liveTail = trackModel.actual.slice();
        const now = Date.now();
        trackModel.actual = pts.slice(-TRACK_TRAIL_CAP).map((p) => [p[0], p[1]]);
        trackStamps = trackModel.actual.map(() => now);
        for (const p of liveTail) {
          const last = trackModel.actual[trackModel.actual.length - 1];
          if (!last || last[0] !== p[0] || last[1] !== p[1]) {
            trackModel.actual.push(p);
            trackStamps.push(now);
          }
        }
        saveTrackTrail();
        draw();
      });
    } catch (e) {
      if (isContextInvalidatedError(e)) showExtensionReloadStatus();
    }
  }

  function trackRouteSummary() {
    const dep = trackModel.dep;
    const arr = trackModel.arr;
    const depTxt = dep ? `${dep.iata || dep.icao || "?"}${dep.name ? " · " + dep.name : ""}` : "Unknown origin";
    const arrTxt = arr ? `${arr.iata || arr.icao || "?"}${arr.name ? " · " + arr.name : ""}` : "Unknown destination";
    return `${depTxt}  →  ${arrTxt}`;
  }

  async function ensureWorldData() {
    if (worldReady) return true;
    if (!window.SKWorldMap) return false;
    try {
      await SKWorldMap.load();
      worldReady = true;
      return true;
    } catch (_) {
      return false;
    }
  }

  function startTrackLoops() {
    clearInterval(trackPoll);
    clearInterval(trackPulse);
    trackPoll = setInterval(pollTrack, TRACK_POLL_MS);
    trackPulse = setInterval(draw, TRACK_PULSE_MS);
  }

  function stopTrackLoops() {
    clearInterval(trackPoll);
    clearInterval(trackPulse);
    trackPoll = null;
    trackPulse = null;
  }

  function startTailWatchPoll() {
    clearInterval(tailWatchPoll);
    tailWatchPoll = setInterval(() => {
      if (!windowActive()) {
        showExtensionReloadStatus();
        return;
      }
      if ((tailWatch || cfg.tailWatch) && cfg.trackTail) tryEngageTail(cfg.trackTail);
    }, TRACK_POLL_MS);
  }

  function stopTailWatchPoll() {
    clearInterval(tailWatchPoll);
    tailWatchPoll = null;
  }

  function acToLive(ac) {
    return {
      hex: ac.hex,
      flight: (ac.flight || "").trim(),
      lat: ac.lat,
      lon: ac.lon,
      track: ac.track ?? null,
      alt_baro: ac.alt_baro,
      gs: ac.gs ?? null,
      squawk: ac.squawk ?? null,
      emergency: ac.emergency ?? null,
      t: ac.t || null,
    };
  }

  function localLiveHintForFlight(flight) {
    const norm = String(flight || "").trim().toUpperCase().replace(/[\s-]/g, "");
    if (!norm) return null;
    const hit = aircraft.find((a) => {
      const fl = String(a.flight || "").trim().toUpperCase().replace(/[\s-]/g, "");
      return fl && (fl === norm || fl.endsWith(norm) || norm.endsWith(fl));
    });
    return hit?.lat != null ? acToLive(hit) : null;
  }

  async function engageTrackResponse(res, label) {
    const dep = res.route ? await resolveTrackCoords(res.route.dep) : null;
    const arr = res.route ? await resolveTrackCoords(res.route.arr) : null;
    trackModel = { dep, arr, live: res.live || null, planned: [], actual: [] };
    trackStamps = [];
    buildTrackPlanned();

    // Key the trail on the user-facing label (flight/tail), matching overlay.js.
    // Keying on res.live.hex broke cross-page resume — restoreTrackPreview only
    // has the label and could never reconstruct a hex-based key, so a resumed
    // track appeared to lose its recorded trail.
    trackKey = `trackerTrail:${label}`;
    const trail = await loadTrackTrail(trackKey);
    trackModel.actual = trail.pts;
    trackStamps = trail.ts;
    if (res.live) appendTrackTrail(res.live);
    // Backfill the historical flown path from the ADS-B trace on a fresh track.
    seedTrackFromTrace(res.live?.hex, trackKey);

    trackMode = true;
    tailWatch = false;
    pendingSource = null;
    stopTailWatchPoll();
    clearTimeout(refreshTimer);
    clearTimeout(fetchWatchdog);
    fetchWatchdog = null;
    fetchReq++;
    cancelAnimationFrame(animId);
    animId = null;

    trackStatusText = res.live
      ? `Tracking ${res.callsign || label}`
      : `Route for ${res.callsign || label} · not currently live`;

    setSourceMode("track");
    syncTrackUI();
    applyTrackerOpacity();
    $("trackStatus").textContent = `${trackStatusText} — ${trackRouteSummary()}`;
    draw();
    startTrackLoops();
  }

  async function startTrack(flightRaw, opts = {}) {
    if (!isEntitled()) {
      if (opts.resume) {
        clearTrack({ keepCfg: false });
        return;
      }
      if (!(await requireEntitlement())) return;
    }
    const flight = (flightRaw || "").trim().toUpperCase();
    if (!flight || trackBusy) return;
    trackBusy = true;

    if (!opts.resume) {
      $("trackBtn").disabled = true;
      $("trackStatus").textContent = "Searching…";
    }

    const ok = await ensureWorldData();
    if (!ok) {
      trackBusy = false;
      $("trackBtn").disabled = false;
      $("trackStatus").textContent = "Map data failed to load.";
      return;
    }

    if (!opts.resume) {
      tailWatch = false;
      stopTailWatchPoll();
      saveCfg({
        viewMode: "tracker",
        trackFlight: flight,
        trackTail: "",
        trackKind: "flight",
        tailWatch: false,
      });
    }

    if (!isExtensionContextValid()) {
      trackBusy = false;
      $("trackBtn").disabled = false;
      showExtensionReloadStatus();
      return;
    }
    try {
      chrome.runtime.sendMessage(
        { type: "fetch-flight", flight, liveHint: localLiveHintForFlight(flight) },
        async (res) => {
          trackBusy = false;
          $("trackBtn").disabled = false;
          drainRuntimeLastError();
          if (!res || !res.ok) {
            $("trackStatus").textContent = res?.error || "Flight not found or not currently tracked.";
            if (!trackMode && !opts.resume) saveCfg({ viewMode: "radar" });
            return;
          }
          await engageTrackResponse(res, flight);
        }
      );
    } catch (e) {
      trackBusy = false;
      $("trackBtn").disabled = false;
      if (isContextInvalidatedError(e)) showExtensionReloadStatus();
    }
  }

  async function tryEngageTail(tail) {
    if (!isExtensionContextValid()) {
      stopTailWatchPoll();
      return;
    }
    if (!tail || trackBusy) return;
    const norm = SKRadar.normalizeTail(tail);
    if (!norm) return;

    const hit = aircraft.find((a) => SKRadar.acMatchesTail(a, norm));
    const msg = hit
      ? { type: "fetch-tail", tail: norm, liveHint: acToLive(hit) }
      : { type: "fetch-tail", tail: norm };

    trackBusy = true;
    try {
      chrome.runtime.sendMessage(msg, async (res) => {
        drainRuntimeLastError();
        trackBusy = false;
        if (!res?.ok) {
          if (tailWatch || cfg.tailWatch) {
            trackStatusText = `Waiting for ${norm}…`;
            $("trackStatus").textContent = trackStatusText;
          }
          return;
        }
        if (res.waiting || !res.live) {
          if (tailWatch || cfg.tailWatch) {
            trackStatusText = `Waiting for ${norm}…`;
            $("trackStatus").textContent = trackStatusText;
          }
          return;
        }
        saveCfg({
          viewMode: "tracker",
          tailWatch: false,
          trackTail: norm,
          trackKind: "tail",
          trackFlight: "",
        });
        const mapOk = await ensureWorldData();
        if (!mapOk) return;
        await engageTrackResponse(res, norm);
      });
    } catch (e) {
      trackBusy = false;
      if (isContextInvalidatedError(e)) {
        stopTailWatchPoll();
        showExtensionReloadStatus();
      }
    }
  }

  async function startTrackTail(tailRaw, opts = {}) {
    if (!isEntitled()) {
      if (opts.resume) {
        clearTrack({ keepCfg: false });
        return;
      }
      if (!(await requireEntitlement())) return;
    }
    const tail = SKRadar.normalizeTail(tailRaw);
    if (!tail || trackBusy) return;

    if (!opts.resume) {
      $("trackBtn").disabled = true;
      $("trackStatus").textContent = "Searching…";
    }

    const ok = await ensureWorldData();
    if (!ok) {
      trackBusy = false;
      $("trackBtn").disabled = false;
      $("trackStatus").textContent = "Map data failed to load.";
      return;
    }

    if (!opts.resume) {
      tailWatch = true;
      trackStatusText = `Waiting for ${tail}…`;
      saveCfg({
        trackKind: "tail",
        trackTail: tail,
        trackFlight: "",
        tailWatch: true,
        viewMode: "radar",
      });
      syncTrackUI();
      startTailWatchPoll();
      tryEngageTail(tail);
      $("trackBtn").disabled = false;
      return;
    }

    trackBusy = true;
    if (!isExtensionContextValid()) {
      trackBusy = false;
      showExtensionReloadStatus();
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: "fetch-tail", tail }, async (res) => {
        trackBusy = false;
        drainRuntimeLastError();
        if (!res?.ok) {
          if (!tailWatch) resumeTailWatch();
          return;
        }
        if (res.waiting || !res.live) {
          if (!tailWatch) resumeTailWatch();
          return;
        }
        saveCfg({ viewMode: "tracker", tailWatch: false, trackTail: tail, trackKind: "tail" });
        await engageTrackResponse(res, tail);
      });
    } catch (e) {
      trackBusy = false;
      if (isContextInvalidatedError(e)) showExtensionReloadStatus();
    }
  }

  function resumeTailWatch() {
    if (!cfg.trackTail) return;
    tailWatch = true;
    trackStatusText = `Waiting for ${cfg.trackTail}…`;
    syncTrackUI();
    startTailWatchPoll();
    tryEngageTail(cfg.trackTail);
  }

  async function applyTrackRouteFromPoll(res) {
    if (!trackMode) return;
    if (res.route && (res.route.dep || res.route.arr)) {
      const dep = await resolveTrackCoords(res.route.dep);
      const arr = await resolveTrackCoords(res.route.arr);
      trackModel.dep = dep;
      trackModel.arr = arr;
      buildTrackPlanned();
    }
  }

  function pollTrack() {
    // Stop polling once the extension context is gone (reload/update) — otherwise
    // sendMessage throws "Extension context invalidated" on every tick.
    if (!windowActive()) {
      showExtensionReloadStatus();
      return;
    }
    const byTail = trackKind() === "tail" && cfg.trackTail;
    const liveHint = trackModel.live?.lat != null ? trackModel.live : null;
    const msg = byTail
      ? { type: "fetch-tail", tail: cfg.trackTail, liveHint }
      : { type: "fetch-flight", flight: cfg.trackFlight, liveHint };
    if (byTail ? !cfg.trackTail : !cfg.trackFlight) return;
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        drainRuntimeLastError();
        if (!res || !res.ok || !trackMode) return;
      if (res.live) {
        trackModel.live = res.live;
        appendTrackTrail(res.live);
      }
      const label = byTail ? cfg.trackTail : cfg.trackFlight;
      trackStatusText = res.live ? `Tracking ${res.callsign || label}` : `Route for ${res.callsign || label} · not currently live`;
      $("trackStatus").textContent = `${trackStatusText} — ${trackRouteSummary()}`;
      applyTrackRouteFromPoll(res).then(() => {
        if (trackMode) draw();
      }).catch(handleContextError);
      });
    } catch (e) {
      if (isContextInvalidatedError(e)) {
        stopTrackLoops();
        showExtensionReloadStatus();
      }
    }
  }

  function clearTrack(opts = {}) {
    trackMode = false;
    tailWatch = false;
    pendingSource = null;
    trackStatusText = "";
    stopTrackLoops();
    stopTailWatchPoll();
    if (!opts.keepCfg) {
      saveCfg({
        viewMode: "radar",
        trackFlight: "",
        trackTail: "",
        tailWatch: false,
        trackKind: "flight",
      });
    }
    syncTrackUI();
    applyTrackerOpacity();
    $("trackStatus").textContent = "";
    schedule();
    startSweep();
    draw();
  }

  function maybeSyncTrackMode() {
    if ((cfg.viewMode === "tracker" || cfg.tailWatch) && !isEntitled()) {
      if (trackMode || tailWatch || cfg.viewMode === "tracker") clearTrack({ keepCfg: false });
      return;
    }
    if (cfg.viewMode === "tracker") {
      setSourceMode("track");
      if (trackKind() === "tail" && cfg.trackTail) {
        if (!trackMode && !trackBusy) startTrackTail(cfg.trackTail, { resume: true });
      } else if (cfg.trackFlight) {
        if (!trackMode && !trackBusy) startTrack(cfg.trackFlight, { resume: true });
      }
    } else if (cfg.tailWatch && cfg.trackTail) {
      setSourceMode("track");
      if (!tailWatch) resumeTailWatch();
    } else {
      if (trackMode) clearTrack({ keepCfg: true });
      if (tailWatch) {
        tailWatch = false;
        stopTailWatchPoll();
      }
    }
  }

  function startSweep() {
    cancelAnimationFrame(animId);
    animId = null;
    if (!windowActive()) return;
    if (!cfg.showSweep || isGroundActive()) return;

    const step = () => {
      if (!windowActive()) {
        if (!isExtensionContextValid()) showExtensionReloadStatus();
        return;
      }
      sweepAngle = (sweepAngle + 1.4) % 360;
      draw();
      animId = requestAnimationFrame(step);
    };
    animId = requestAnimationFrame(step);
  }

  function fetchData() {
    if (!windowActive()) {
      if (!isExtensionContextValid()) showExtensionReloadStatus();
      return;
    }
    if (pageHidden) return;
    if (trackMode) return;
    syncCenter();
    if (!center) {
      setStatus("Center unavailable");
      queueFetch();
      return;
    }
    fetchStartedAt = Date.now();
    setStatus("Scanning…");

    const req = ++fetchReq;
    clearTimeout(fetchWatchdog);
    fetchWatchdog = setTimeout(() => {
      if (req !== fetchReq) return;
      fetchWatchdog = null;
      setStatus("Feed timeout — retrying");
      queueFetch();
    }, FETCH_WATCHDOG_MS);

    try {
      chrome.runtime.sendMessage(
        { type: "fetch-aircraft", lat: center.lat, lon: center.lon, dist: fetchRangeNm() },
        (res) => {
          if (req !== fetchReq) return;
          clearTimeout(fetchWatchdog);
          fetchWatchdog = null;
          if (runtimeLastError() || !res?.ok) {
            setStatus(res?.error || "Feed error");
            queueFetch();
            return;
          }
          aircraft = (res.data?.ac || []).filter((a) => a.lat != null && a.lon != null);
          const src = res.source ? ` · ${res.source}` : "";
          const list = SKRadar.filterAircraft(aircraft, effectiveCfg());
          const emgCount = effectiveCfg().showEmergency !== false
            ? list.reduce((n, a) => n + (SKRadar.emergencyInfo(a) ? 1 : 0), 0)
            : 0;
          const gnd = isGroundActive() ? " · GND" : "";
          const emg = emgCount > 0 ? ` · ⚠${emgCount}` : "";
          const lbl = center?.label || center?.icao || "Radar";
          setStatus(`${list.length} aircraft${emg}${gnd} · ${lbl} · ${fetchRangeNm()} nm${src}`);
          draw();
          if ((tailWatch || cfg.tailWatch) && cfg.trackTail) tryEngageTail(cfg.trackTail);
          queueFetch();
        }
      );
    } catch (e) {
      clearTimeout(fetchWatchdog);
      fetchWatchdog = null;
      console.warn("[SkyDesk window] fetchData:", e);
      setStatus("Feed error");
      queueFetch();
    }
  }

  function queueFetch() {
    if (!windowActive()) return;
    clearTimeout(refreshTimer);
    if (pageHidden || trackMode) return;
    const elapsed = fetchStartedAt ? Date.now() - fetchStartedAt : 0;
    const delay = Math.max(300, Math.max(1, cfg.refreshSec || 2) * 1000 - elapsed);
    refreshTimer = setTimeout(fetchData, delay);
  }

  function schedule() {
    if (!windowActive()) return;
    clearTimeout(refreshTimer);
    if (pageHidden || trackMode) return;
    fetchData();
  }

  function onVisibilityChange() {
    pageHidden = document.hidden;
    if (!windowActive()) {
      if (!isExtensionContextValid()) showExtensionReloadStatus();
      return;
    }
    if (pageHidden) {
      clearTimeout(refreshTimer);
      clearTimeout(fetchWatchdog);
      fetchWatchdog = null;
      fetchReq++;
      // Stop the tracker poll (~12s) + draw pulse (~130ms) loops so a hidden
      // full-radar tab tracking a flight stops draining CPU/network/battery.
      if (trackMode) stopTrackLoops();
      stopTailWatchPoll();
      return;
    }
    if (trackMode) {
      startTrackLoops();
      if ((tailWatch || cfg.tailWatch) && cfg.trackTail) startTailWatchPoll();
      pollTrack();
      draw();
    } else {
      if ((tailWatch || cfg.tailWatch) && cfg.trackTail) startTailWatchPoll();
      schedule();
    }
    refreshEntitlement().catch(handleContextError);
  }

  function pickAirport(icao) {
    SK_getAirportAsync(icao, (ap) => {
      if (!ap) {
        $("status").textContent = `Airport not found: ${(icao || "").trim().toUpperCase() || "?"}`;
        return;
      }
      saveCfg({
        centerMode: "airport",
        icao: ap.icao,
        centerLat: ap.lat,
        centerLon: ap.lon,
        centerLabel: ap.icao,
      });
      $("airportQ").value = ap.icao;
      $("suggest").classList.add("hidden");
      setSourceMode("airport");
      syncCenter();
      loadRunways();
      schedule();
    });
  }

  function saveCoords() {
    if (!canUseCoordsMode()) {
      requireEntitlement().then((ok) => {
        if (!ok) showGateFeedback("coords");
      }).catch(handleContextError);
      return;
    }
    const lat = SKCenter.parseCoord($("centerLat").value);
    const lon = SKCenter.parseCoord($("centerLon").value);
    if (!SKCenter.validateLat(lat) || !SKCenter.validateLon(lon)) {
      $("status").textContent = "Enter valid latitude (−90…90) and longitude (−180…180)";
      return;
    }
    const label = $("centerLabel").value.trim() || SKCenter.formatCoords(lat, lon);
    saveCfg({
      centerMode: "coords",
      centerLat: lat,
      centerLon: lon,
      centerLabel: label,
      icao: "",
      proGroundMode: false,
    });
    syncCenter();
    syncGroundControls();
    loadRunways();
    schedule();
  }

  function syncUIControls() {
    const cm = sourceMode();
    setSourceMode(cm);

    $("rangeNm").value = cfg.rangeNm;
    $("rangeVal").textContent = `${cfg.rangeNm} nm`;
    $("opacity").value = cfg.opacity;
    $("opacityVal").textContent = `${cfg.opacity}%`;
    $("heading").value = cfg.heading;
    $("headingVal").textContent = `${headingLabel(cfg.heading)} (${cfg.heading}°)`;
    $("refreshSec").value = cfg.refreshSec || 2;
    $("refreshVal").textContent = `${cfg.refreshSec || 2}s`;
    $("trackerOpacity").value = cfg.trackerOpacity ?? 75;
    $("trackerOpacityVal").textContent = `${cfg.trackerOpacity ?? 75}%`;
    $("groundRangeNm").value = cfg.groundRangeNm ?? 2.5;
    $("groundRangeVal").textContent = `${cfg.groundRangeNm ?? 2.5} nm`;

    const boolDefaults = {
      showRangeRings: true,
      showOuterRing: true,
      showRunways: true,
      showAirportDot: true,
      showHomeMarker: true,
      showOverheadHighlight: true,
      showTagBg: true,
    };
    for (const id of [
      "showAirlines", "showMilitary", "showGa", "showAltitude", "showSpeed", "showType",
      "showSweep", "showWeather", "showTerrain", "showWater", "hideUnder80Kts",
      "proFlightTrack", "proGroundMode", "showOverheadHighlight",
    ]) {
      const el = $(id);
      if (el) el.checked = !!cfg[id];
    }
    for (const [id, def] of Object.entries(boolDefaults)) {
      const el = $(id);
      if (el) el.checked = cfg[id] !== false;
    }
    const showEmergencyEl = $("showEmergency");
    if (showEmergencyEl) showEmergencyEl.checked = effectiveCfg().showEmergency !== false;

    $("tagFontSize").value = cfg.tagFontSize;
    $("tagFontVal").textContent = `${cfg.tagFontSize}px`;
    $("weatherOpacity").value = cfg.weatherOpacity ?? 70;
    $("weatherOpacityVal").textContent = `${cfg.weatherOpacity ?? 70}%`;
    $("terrainOpacity").value = cfg.terrainOpacity ?? 60;
    $("terrainOpacityVal").textContent = `${cfg.terrainOpacity ?? 60}%`;
    $("waterOpacity").value = cfg.waterOpacity ?? 70;
    $("waterOpacityVal").textContent = `${cfg.waterOpacity ?? 70}%`;
    $("homeMarkerColor").value = cfg.homeMarkerColor || "#ffb84d";
    $("homeMarkerOpacity").value = cfg.homeMarkerOpacity ?? 90;
    $("homeMarkerOpacityVal").textContent = `${cfg.homeMarkerOpacity ?? 90}%`;
    $("ringOpacity").value = cfg.ringOpacity ?? 100;
    $("ringOpacityVal").textContent = `${cfg.ringOpacity ?? 100}%`;

    const colors = ["colorPlane", "colorMilitary", "colorTag", "colorTagBg", "colorAirport", "colorRings", "colorRunway"];
    for (const id of colors) {
      const el = $(id);
      if (el && cfg[id]) el.value = cfg[id];
    }

    document.querySelectorAll('input[name="blipStyle"]').forEach((el) => {
      el.checked = el.value === (cfg.blipStyle || "plane");
    });

    $("airportQ").value = cfg.centerMode === "airport" ? (cfg.icao || "") : "";
    $("centerLat").value = cfg.centerLat ?? "";
    $("centerLon").value = cfg.centerLon ?? "";
    $("centerLabel").value = cfg.centerLabel || "";

    syncTrackUI();
    syncGroundControls();
    syncHomeMarkerControls();
    syncGatedControls();
    syncEntitlementControls();
    applyTrackerOpacity();
  }

  function bindControls() {
    if (controlsBound) return;
    controlsBound = true;

    $("trackBtn")?.addEventListener("click", async () => {
      if (!(await requireEntitlement())) return;
      const kind = document.querySelector('input[name="trackKind"]:checked')?.value || "flight";
      if (kind === "tail") startTrackTail($("tailInput").value);
      else startTrack($("flightInput").value);
    });
    $("clearTrack")?.addEventListener("click", () => clearTrack());

    document.querySelectorAll('input[name="trackKind"]').forEach((el) => {
      el.addEventListener("change", () => {
        if (!el.checked) return;
        saveCfg({ trackKind: el.value });
        syncTrackUI();
      });
    });

    $("flightInput")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        startTrack($("flightInput").value);
      }
    });
    $("tailInput")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        startTrackTail($("tailInput").value);
      }
    });

    document.querySelectorAll('input[name="centerMode"]').forEach((el) => {
      el.addEventListener("change", (e) => {
        if (!e.target.checked) return;
        const mode = e.target.value;
        if (mode === "track") {
          if (!canUseTrackMode()) {
            requireEntitlement().then((ok) => {
              if (!ok) {
                showGateFeedback("track");
                pendingSource = null;
                setSourceMode(sourceMode());
                return;
              }
              pendingSource = "track";
              setSourceMode("track");
              if (cfg.viewMode === "tracker" || cfg.tailWatch) maybeSyncTrackMode();
              else {
                const kind = trackKind();
                if (kind === "tail" && cfg.trackTail) startTrackTail(cfg.trackTail);
                else if (cfg.trackFlight) startTrack(cfg.trackFlight);
                else (kind === "tail" ? $("tailInput") : $("flightInput"))?.focus();
              }
            }).catch(handleContextError);
            return;
          }
          pendingSource = "track";
          setSourceMode("track");
          if (cfg.viewMode === "tracker" || cfg.tailWatch) {
            maybeSyncTrackMode();
          } else {
            const kind = trackKind();
            if (kind === "tail" && cfg.trackTail) startTrackTail(cfg.trackTail);
            else if (cfg.trackFlight) startTrack(cfg.trackFlight);
            else (kind === "tail" ? $("tailInput") : $("flightInput"))?.focus();
          }
          return;
        }
        pendingSource = null;
        if (trackMode || tailWatch) clearTrack({ keepCfg: true });
        if (mode === "coords") {
          if (!canUseCoordsMode()) {
            requireEntitlement().then((ok) => {
              if (!ok) {
                showGateFeedback("coords");
                setSourceMode("airport");
                return;
              }
              cfg.centerMode = "coords";
              setSourceMode("coords");
              saveCoords();
            }).catch(handleContextError);
            return;
          }
          cfg.centerMode = "coords";
          setSourceMode("coords");
          saveCoords();
          return;
        }
        cfg.centerMode = "airport";
        setSourceMode("airport");
        saveCfg({ centerMode: "airport" });
        syncGroundControls();
        loadRunways();
        schedule();
      });
    });

    let searchTimer = null;
    $("airportQ")?.addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        SK_searchAirportsAsync(e.target.value, 14, (hits) => {
          const ul = $("suggest");
          ul.innerHTML = hits
            .map((a) => {
              const b = badge(a);
              const tag = b ? ` <em>[${esc(b)}]</em>` : "";
              const iata = a.iata ? ` / ${esc(a.iata)}` : "";
              return `<li data-icao="${esc(a.icao)}">${esc(a.icao)}${iata} — ${esc(a.name)}${tag}</li>`;
            })
            .join("");
          ul.classList.toggle("hidden", !hits.length);
          ul.querySelectorAll("li").forEach((li) => {
            li.onclick = () => pickAirport(li.dataset.icao);
          });
        });
      }, 120);
    });
    $("airportQ")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") pickAirport(e.target.value);
    });

    ["centerLat", "centerLon", "centerLabel"].forEach((id) => {
      $(id)?.addEventListener("change", () => {
        if (cfg.centerMode === "coords") saveCoords();
      });
    });

    $("geoBtn")?.addEventListener("click", () => {
      if (!navigator.geolocation) return;
      if (!canUseCoordsMode()) {
        requireEntitlement().then((ok) => {
          if (!ok) showGateFeedback("location");
        }).catch(handleContextError);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          $("centerLat").value = pos.coords.latitude.toFixed(5);
          $("centerLon").value = pos.coords.longitude.toFixed(5);
          if (!$("centerLabel").value.trim()) $("centerLabel").value = "Home";
          document.querySelector('input[name="centerMode"][value="coords"]').checked = true;
          setSourceMode("coords");
          saveCoords();
        },
        () => {},
        { enableHighAccuracy: true, timeout: 12000 }
      );
    });

    const sliderPairs = [
      ["rangeNm", "rangeVal", (v) => `${v} nm`, () => schedule()],
      ["opacity", "opacityVal", (v) => `${v}%`, () => draw()],
      ["heading", "headingVal", (v) => `${headingLabel(v)} (${v}°)`, () => draw()],
      ["refreshSec", "refreshVal", (v) => `${v}s`, () => schedule()],
      ["tagFontSize", "tagFontVal", (v) => `${v}px`, () => draw()],
      ["trackerOpacity", "trackerOpacityVal", (v) => `${v}%`, () => applyTrackerOpacity()],
      ["groundRangeNm", "groundRangeVal", (v) => `${v} nm`, () => schedule()],
    ];
    for (const [id, valId, fmt, after] of sliderPairs) {
      $(id)?.addEventListener("input", (e) => {
        const val = Number(e.target.value);
        cfg[id] = val;
        setText(valId, fmt(val));
        queueCfgPatch({ [id]: val });
        after();
      });
    }

    [
      ["weatherOpacity", "weatherOpacityVal"],
      ["terrainOpacity", "terrainOpacityVal"],
      ["waterOpacity", "waterOpacityVal"],
      ["ringOpacity", "ringOpacityVal"],
      ["homeMarkerOpacity", "homeMarkerOpacityVal"],
    ].forEach(([id, valId]) => {
      $(id)?.addEventListener("input", (e) => {
        cfg[id] = Number(e.target.value);
        setText(valId, `${cfg[id]}%`);
        queueCfgPatch({ [id]: cfg[id] });
        draw();
      });
    });

    const colorIds = ["homeMarkerColor", "colorPlane", "colorMilitary", "colorTag", "colorTagBg", "colorAirport", "colorRings", "colorRunway"];
    for (const id of colorIds) {
      $(id)?.addEventListener("input", (e) => {
        cfg[id] = e.target.value;
        queueCfgPatch({ [id]: cfg[id] });
        draw();
      });
    }

    const checkboxes = [
      "showAirlines", "showMilitary", "showGa", "showAltitude", "showSpeed", "showType",
      "showSweep", "showWeather", "showTerrain", "showWater", "showAirportDot", "showHomeMarker",
      "showOverheadHighlight", "showRangeRings", "showOuterRing", "showRunways", "showTagBg", "hideUnder80Kts",
      "showEmergency", "proFlightTrack",
    ];
    for (const id of checkboxes) {
      $(id)?.addEventListener("change", (e) => {
        const val = e.target.checked;
        gateCfgToggle(id, val, () => {
          cfg[id] = val;
          saveCfg({ [id]: val });
          if (id === "showSweep") startSweep();
          if (id === "proFlightTrack" && !val) clearFlightSelection();
          draw();
        });
      });
    }

    $("proGroundMode")?.addEventListener("change", (e) => {
      const val = e.target.checked;
      if (val && !canUseGroundMode()) {
        e.target.checked = false;
        return;
      }
      gateCfgToggle("proGroundMode", val, () => {
        cfg.proGroundMode = val;
        saveCfg({ proGroundMode: val });
        startSweep();
        schedule();
        draw();
      });
    });

    document.querySelectorAll('input[name="blipStyle"]').forEach((el) => {
      el.addEventListener("change", (e) => {
        if (!e.target.checked) return;
        cfg.blipStyle = e.target.value;
        saveCfg({ blipStyle: cfg.blipStyle });
        draw();
      });
    });

    $("settingsPanelCollapse")?.addEventListener("click", () => setSettingsPanelCollapsed(true));
    $("settingsPanelExpand")?.addEventListener("click", () => setSettingsPanelCollapsed(false));

    $("privacyLink")?.addEventListener("click", (e) => {
      e.preventDefault();
      if (!isExtensionContextValid()) return;
      try {
        const url = chrome.runtime.getURL("src/privacy/privacy.html");
        chrome.tabs?.create ? chrome.tabs.create({ url }) : window.open(url, "_blank");
      } catch (_) {}
    });
    $("termsLink")?.addEventListener("click", (e) => {
      e.preventDefault();
      if (!isExtensionContextValid()) return;
      try {
        const url = chrome.runtime.getURL("src/privacy/terms.html");
        chrome.tabs?.create ? chrome.tabs.create({ url }) : window.open(url, "_blank");
      } catch (_) {}
    });

    $("trialBtn")?.addEventListener("click", () => {
      safeSendMessage({ type: "open-trial" });
    });
    $("subBtn")?.addEventListener("click", () => {
      safeSendMessage({ type: "open-subscription" });
    });

    canvas?.addEventListener("click", (e) => {
      if (trackMode) return;
      if (e.shiftKey && shiftFlightPickEnabled()) {
        const hit = SKRadar.hitTestClient(lastDrawList, canvas, e.clientX, e.clientY, 18, lastDrawW, lastDrawH);
        const hitKey = hit ? SKRadar.acKey(hit) : null;
        if (hitKey && hitKey === selectedKey) {
          clearFlightSelection();
          return;
        }
        selectedKey = hitKey;
        selected = hit;
        routeInfo = hit ? null : undefined;
        updateSelectedCard();
        if (hit) {
          if (cfg.proFlightTrack && !flightPathTrackActive()) showGateFeedback();
          fetchRouteFor(hit);
        }
        draw();
        return;
      }
      const list = SKRadar.filterAircraft(aircraft, effectiveCfg());
      selected = SKRadar.hitTest(list, e.clientX, e.clientY);
      selectedKey = selected ? SKRadar.acKey(selected) : null;
      routeInfo = undefined;
      const el = $("selected");
      if (!selected) {
        el?.classList.add("hidden");
      } else if (el) {
        const info = SKRadar.formatCard(selected);
        el.classList.remove("hidden");
        el.innerHTML = `<strong>${esc(info.title)}</strong><br>${info.lines.map(esc).join("<br>")}`;
      }
      draw();
    });

    addEventListener("keydown", (e) => {
      if (e.key === "Escape" && selectedKey) clearFlightSelection();
    });
  }

  function loadSettings() {
    if (!chrome.storage?.sync) {
      cfg = { ...DEFAULTS };
      syncCenter();
      syncUIControls();
      bindControls();
      if (!trackMode) {
        loadRunways();
        schedule();
        startSweep();
      }
      return;
    }
    chrome.storage.sync.get(null, (s) => {
      drainRuntimeLastError();
      try {
        cfg = { ...DEFAULTS, ...s };
        if (cfg.centerMode !== "airport" || !cfg.icao) cfg.proGroundMode = false;
        syncCenter();
        syncUIControls();
        setSettingsPanelCollapsed(!!cfg.settingsPanelCollapsed, false);
        bindControls();
        refreshEntitlement().then(() => {
          enforceEntitlement();
          syncUIControls();
          maybeSyncTrackMode();
          if (!trackMode) {
            loadRunways();
            schedule();
            startSweep();
          }

          if (location.hash === "#track") {
            setSettingsPanelCollapsed(false);
            pendingSource = "track";
            setSourceMode("track");
            $("flightInput")?.focus();
          }
        }).catch(handleContextError);

        if (!window.__SKYDESK_ENTITLE_REFRESH) {
          window.__SKYDESK_ENTITLE_REFRESH = true;
          entitleRefreshInterval = setInterval(() => {
            if (!windowActive()) {
              showExtensionReloadStatus();
              return;
            }
            refreshEntitlement().catch(handleContextError);
          }, 30 * 60 * 1000);
        }
      } catch (e) {
        console.warn("[SkyDesk window] loadSettings:", e);
      }
    });
  }

  chrome.storage?.onChanged?.addListener((changes, area) => {
    try {
      if (area === "local" && changes.skEntitlementCache) {
        const next = changes.skEntitlementCache.newValue;
        entitlement = next ? { ...next, ok: true } : { active: false, ok: false };
        syncSubscriptionUI();
        enforceEntitlement();
        return;
      }
    if (area !== "sync") return;
    let centerChanged = false;
    let trackChanged = false;
    for (const [k, { newValue }] of Object.entries(changes)) {
      cfg[k] = newValue;
      if (["icao", "centerMode", "centerLat", "centerLon", "centerLabel"].includes(k)) {
        centerChanged = true;
      }
      if (["viewMode", "trackFlight", "trackTail", "tailWatch", "trackKind"].includes(k)) {
        trackChanged = true;
      }
    }
    if (cfg.centerMode !== "airport" || !cfg.icao) cfg.proGroundMode = false;
    syncCenter();
    syncUIControls();
    if ("settingsPanelCollapsed" in changes) {
      setSettingsPanelCollapsed(!!cfg.settingsPanelCollapsed, false);
    }
    if (trackChanged) maybeSyncTrackMode();
    else if (centerChanged) loadRunways();
    else if (!trackMode) {
      if ("refreshSec" in changes || "proGroundMode" in changes || "rangeNm" in changes || "groundRangeNm" in changes) {
        schedule();
      }
      if ("showSweep" in changes || "proGroundMode" in changes) startSweep();
      draw();
    }
    } catch (e) {
      console.warn("[SkyDesk window] storage.onChanged:", e);
    }
  });

  try {
    chrome.runtime?.onMessage?.addListener((msg) => {
      if (msg.type === "entitlement-updated" && msg.state) {
        entitlement = msg.state;
        syncSubscriptionUI();
        enforceEntitlement();
      }
    });
  } catch (_) {}

  addEventListener("resize", resize);
  document.addEventListener("visibilitychange", onVisibilityChange);
  try {
    if (!windowActive()) {
      showExtensionReloadStatus();
    } else {
      syncCenter();
      resize();
      loadSettings();
    }
  } catch (e) {
    if (isContextInvalidatedError(e)) {
      showExtensionReloadStatus();
    } else {
      console.warn("[SkyDesk window] boot failed:", e);
    }
  }
})();
