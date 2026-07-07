(() => {
  // SINGLETON GUARD (part 1 of 2): never run outside the top-level frame.
  // The manifest uses `match_origin_as_fallback`, which lets this content script
  // be injected into about:blank / about:srcdoc / data: child frames that some
  // pages (e.g. Google search) create. Each such frame is its own document with
  // its own window, so the per-window `__SKYDESK_READY` flag below does NOT stop
  // a child frame from mounting a SECOND overlay root that visually floats over
  // the page. Bailing in sub-frames guarantees exactly one overlay per tab.
  // `window.top !== window.self` is a cross-origin-safe identity comparison and
  // is always false in the real top frame (even an about:blank top frame).
  if (window.top !== window.self) return;

  // Never mount on ExtensionPay checkout/login — ExtPay owns that origin. If the
  // user reloads the extension mid-billing, a stranded overlay here surfaces
  // "Extension context invalidated" on every promise tick.
  const host = location.hostname;
  if (host === "extensionpay.com" || host.endsWith(".extensionpay.com")) return;

  function isExtensionContextValid() {
    try {
      return !!chrome.runtime?.id;
    } catch (_) {
      return false;
    }
  }

  if (!isExtensionContextValid()) return;

  // SINGLETON GUARD (part 2 of 2): one boot per window/document.
  if (window.__SKYDESK_READY) return;
  window.__SKYDESK_READY = true;
  window.__SKYDESK_BOOTED = true;

  const TAG = "skydesk-root";
  // Per-page debug logging is off by default; set window.__SKYDESK_DEBUG = true
  // from the console to see mount/diagnostic logs.
  const DEBUG = !!window.__SKYDESK_DEBUG;
  const SIZE = 248;
  const MIN_SIZE = 150;
  const MAX_SIZE = 560;
  const MODES = ["corner", "background", "minimized"];
  const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  const EXT_RELOAD_MSG = "Refresh page — SkyDesk was updated";
  let extContextLost = false;
  let entitleRefreshInterval = null;

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

  function overlayActive() {
    return !extContextLost && isExtensionContextValid();
  }

  function haltOverlayActivity() {
    if (extContextLost) return false;
    extContextLost = true;
    clearTimeout(timer);
    timer = null;
    clearTimeout(fetchWatchdog);
    fetchWatchdog = null;
    clearTimeout(feedCacheSaveTimer);
    feedCacheSaveTimer = null;
    clearTimeout(commitTimer);
    commitTimer = null;
    clearTimeout(rescheduleTimer);
    rescheduleTimer = null;
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
    if (fetching || fetchWatchdog) {
      fetchReq++;
      fetching = false;
      clearTimeout(fetchWatchdog);
      fetchWatchdog = null;
    }
    return true;
  }

  function showExtensionReloadStatus() {
    if (!haltOverlayActivity()) return;
    const status = root?.querySelector(".sk-sub-status");
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

  // Trusted Types guard. Pages like google.com send a strict CSP with
  // `require-trusted-types-for 'script'`, which makes DOM HTML sinks
  // (innerHTML / insertAdjacentHTML) throw `TypeError: ... requires 'TrustedHTML'
  // assignment` unless the value is a TrustedHTML from an allowed policy. Content
  // scripts run in an isolated world but share the page DOM, so our mount() sinks
  // are governed by it — without this, mount() threw on the first innerHTML and the
  // widget never appeared on Google. We create one policy (feature-detected): if the
  // page's `trusted-types` directive disallows our name we retry with a unique name,
  // then fall back to null (plain strings) on pages with no Trusted Types at all.
  const TT = (() => {
    if (!(window.trustedTypes && window.trustedTypes.createPolicy)) return null;
    const rules = { createHTML: (s) => s };
    try {
      return window.trustedTypes.createPolicy("skydesk", rules);
    } catch (_) {
      try {
        return window.trustedTypes.createPolicy(
          "skydesk-" + Math.random().toString(36).slice(2),
          rules
        );
      } catch (_) {
        return null;
      }
    }
  })();

  // Route every HTML-string insertion through these so the value becomes TrustedHTML
  // on Trusted-Types pages, while staying a plain no-op assignment everywhere else.
  function setHTML(el, html) {
    el.innerHTML = TT ? TT.createHTML(html) : html;
  }
  function insertHTML(el, pos, html) {
    el.insertAdjacentHTML(pos, TT ? TT.createHTML(html) : html);
  }
  const DEFAULTS = {
    enabled: true,
    overlay: true,
    displayMode: "background",
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
    preTrackDisplayMode: "",
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
    colorMenu: "#2a8a42",
    widgetSize: SIZE,
    chromePos: null, // {x,y} viewport coords when the settings chrome has been dragged free
    triggerPos: null, // legacy — migrated to chromePos
  };

  let cfg = { ...DEFAULTS };
  let center = null;
  let aircraft = [];
  let timer = null;
  let fetchStartedAt = 0;
  let animId = null;
  let widgetSize = SIZE;
  let renderList = [];
  let pendingPatch = {};
  let commitTimer = null;
  let rescheduleTimer = null;
  let skipNextSync = false;
  const EASE = 0.22;
  let pos = { x: null, y: null };
  let root = null;
  let feedSource = "";
  let sweepAngle = 0;
  let runways = [];
  let runwayReq = 0;
  let terminals = [];
  let terminalReq = 0;
  let airportInfo = null;
  let airportInfoReq = 0;
  let fetching = false;
  let initialFetchDone = false;
  let selectedAc = null;
  let selectedAcSnapshot = null;
  let selectedKey = null;
  let routeInfo = undefined;
  let chromePos = null; // {x,y} viewport coords when the settings chrome has been dragged free
  let lastChromeViewportPos = null; // last known chrome top-left (for minimize-from-background)
  let menuEl = null; // persistent .sk-menu node
  let triggerEl = null; // persistent .sk-head-trigger node
  let entitlement = { active: false, ok: false };
  let lastNonMinMode = "background"; // restore target when un-minimizing
  let lastDrawList = [];
  let lastDrawW = SIZE;
  let lastDrawH = SIZE;
  let fetchReq = 0;
  const FETCH_WATCHDOG_MS = 18000;
  let fetchWatchdog = null;
  let feedFailStreak = 0;
  let pageHidden = typeof document !== "undefined" ? document.hidden : false;
  let lastFeedSig = "";
  // Module-level guards for listeners attached to `window` (not the widget root).
  // A remount creates a fresh root, so root.dataset.* guards don't prevent these
  // global handlers from accumulating — gate them here instead. The handlers read
  // the module-level `root`, so they always act on the current widget.
  let flightPickWindowBound = false;
  let helpWindowBound = false;
  const TRIAL_TOUR_DONE_KEY = "skTrialTourDone";
  const TRIAL_TOUR_PENDING_KEY = "skTrialTourPending";
  const WELCOME_DONE_KEY = "skWelcomeDone";
  let welcomeActive = false;
  let welcomeStepIndex = -1;
  let tourActive = false;
  let tourStepIndex = -1;
  let tourRepositionBound = false;
  // Tracks the last-known entitlement so we can detect an inactive→active
  // transition (e.g. an auto-started local trial resolving after boot) and
  // re-merge the gated settings that were stripped from the in-memory cfg.
  let wasEntitled = null;

  // ---- Flight Tracker (in-page world-map view) ----
  const TRACK_POLL_MS = 12000;
  const TRACK_PULSE_MS = 130;
  const TRACK_TRAIL_CAP = 800;
  const TRACK_TRAIL_MIN_NM = 0.5;
  const TRACK_MAX_AGE_MS = 6 * 60 * 60 * 1000;
  let trackMode = false;
  let worldReady = false;
  let trackModel = { dep: null, arr: null, live: null, planned: [], actual: [] };
  let trackStamps = [];
  let trackKey = null;
  let trackPoll = null;
  let trackPulse = null;
  let trackStatusText = "";
  let trackBusy = false;
  let tailWatch = false;
  let tailWatchPoll = null;
  // Transient menu selection of "track" before a flight has been entered (so the
  // track panel doesn't snap back to airport/coords on the next menu re-sync).
  let pendingSource = null;

  const FEED_CACHE_KEY = "sk_feed_cache";
  const FEED_CACHE_TTL_MS = 60000;
  const FEED_CACHE_SAVE_DEBOUNCE_MS = 400;
  const SELECTED_AC_KEY = "sk_selected_aircraft";
  const SELECTED_AC_TTL_MS = 10 * 60 * 1000;
  let feedCacheSaveTimer = null;
  let showingCachedFeed = false;

  function feedDataSig(ac) {
    if (!ac?.length) return "0";
    let mix = ac.length * 0x9e3779b1;
    const step = ac.length > 64 ? Math.ceil(ac.length / 64) : 1;
    for (let i = 0; i < ac.length; i += step) {
      const a = ac[i];
      mix ^= (Math.round((a.lat || 0) * 800) & 0xffff) << (i % 16);
      mix ^= Math.round((a.lon || 0) * 800) & 0xffff;
      mix = (mix * 2654435761) >>> 0;
    }
    return String(mix);
  }

  function feedCacheId() {
    if (!center || center.lat == null || center.lon == null) return null;
    const lat = Number(center.lat);
    const lon = Number(center.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const dist = fetchRangeNm();
    return `${lat.toFixed(4)},${lon.toFixed(4)},${dist}`;
  }

  function isGroundActive() {
    return window.SKRadar?.isGroundMode?.(cfg) ?? false;
  }

  function cornerSize() {
    const n = Number(widgetSize) || SIZE;
    return Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(n)));
  }

  function applyTheme() {
    if (!root) return;
    const menuColor = cfg.colorMenu || "#2a8a42";
    root.style.setProperty("--sk-menu", menuColor);
    if (menuEl && menuEl.parentElement === document.body) {
      menuEl.style.setProperty("--sk-menu", menuColor);
    }
  }

  function getMenu() {
    if (menuEl?.isConnected) {
      if (root && menuEl.parentElement === document.body && !root.contains(menuEl)) {
        const docked = root.querySelector(".sk-menu");
        if (docked) {
          menuEl.remove();
          menuEl = docked;
        }
      }
      return menuEl;
    }
    menuEl = root?.querySelector(".sk-menu") || null;
    return menuEl;
  }

  function chromeFloated() {
    return chromePos != null;
  }

  function getTrigger() {
    if (triggerEl?.isConnected) return triggerEl;
    triggerEl = root?.querySelector(".sk-head-trigger") || null;
    return triggerEl;
  }

  // The title span lives inside the trigger, which may be docked in the header
  // or floated on document.body — resolve it from whichever holds it now.
  function titleEl() {
    return getTrigger()?.querySelector(".sk-title") || root?.querySelector(".sk-title") || null;
  }

  function fetchRangeNm() {
    return isGroundActive() ? cfg.groundRangeNm || 2.5 : cfg.rangeNm;
  }

  function canUseGroundMode() {
    return cfg.centerMode === "airport" && !!(cfg.icao || "").trim();
  }

  function toggleGroundMode() {
    if (!canUseGroundMode()) return;
    if (!cfg.proGroundMode && !isEntitled()) {
      requireEntitlement().then((ok) => {
        if (ok) saveCfg({ proGroundMode: true });
      }).catch(handleContextError);
      return;
    }
    saveCfg({ proGroundMode: !cfg.proGroundMode });
  }

  function syncGroundBtn() {
    const btn = root?.querySelector(".sk-gnd-btn");
    if (!btn) return;
    const ok = canUseGroundMode();
    btn.hidden = !ok;
    btn.classList.toggle("sk-active", isGroundActive());
    btn.setAttribute(
      "aria-pressed",
      isGroundActive() ? "true" : "false"
    );
    btn.title = isGroundActive()
      ? "Ground mode on — click to turn off"
      : "Airport ground mode — click to turn on";
  }

  function visualMode() {
    try {
      if (isGroundActive() && mode() !== "minimized") return "background";
      return mode();
    } catch (e) {
      console.warn("[SkyDesk] visualMode:", e);
      return mode();
    }
  }

  function applyFeedCacheHit(hit) {
    try {
      const id = feedCacheId();
      if (
        hit &&
        id &&
        hit.id === id &&
        Date.now() - (hit.ts || 0) < FEED_CACHE_TTL_MS &&
        Array.isArray(hit.ac)
      ) {
        aircraft = hit.ac;
        feedSource = hit.source ? `${hit.source} · cached` : "cached";
        initialFetchDone = true;
        showingCachedFeed = true;
        return true;
      }
    } catch (e) {
      console.warn("[SkyDesk] feed cache:", e);
    }
    return false;
  }

  function loadCachedFeed(done) {
    if (!chrome.storage?.local) {
      done?.();
      return;
    }
    chrome.storage.local.get(FEED_CACHE_KEY, (stored) => {
      drainRuntimeLastError();
      syncCenter();
      applyFeedCacheHit(stored?.[FEED_CACHE_KEY]);
      done?.();
    });
  }

  function saveFeedCache(ac, source) {
    const id = feedCacheId();
    if (!id || !chrome.storage?.local) return;
    clearTimeout(feedCacheSaveTimer);
    feedCacheSaveTimer = setTimeout(() => {
      feedCacheSaveTimer = null;
      chrome.storage.local.set({
        [FEED_CACHE_KEY]: { id, ac, source, ts: Date.now() },
      });
    }, FEED_CACHE_SAVE_DEBOUNCE_MS);
  }

  function saveSelectedAircraft() {
    if (!chrome.storage?.local) return;
    if (!selectedKey || !selectedAc) {
      chrome.storage.local.remove(SELECTED_AC_KEY);
      return;
    }
    const snap = {
      hex: selectedAc.hex,
      flight: selectedAc.flight,
      r: selectedAc.r,
      t: selectedAc.t,
      alt_baro: selectedAc.alt_baro,
      gs: selectedAc.gs,
      dst: selectedAc.dst,
      lat: selectedAc.lat,
      lon: selectedAc.lon,
      track: selectedAc.track,
      squawk: selectedAc.squawk,
      emergency: selectedAc.emergency,
    };
    chrome.storage.local.set({
      [SELECTED_AC_KEY]: {
        key: selectedKey,
        ac: snap,
        routeInfo: routeInfo === undefined ? undefined : routeInfo,
        centerId: feedCacheId(),
        ts: Date.now(),
      },
    });
  }

  function restoreSelectedAircraft(stored) {
    const hit = stored?.[SELECTED_AC_KEY] ?? stored;
    if (!hit || typeof hit !== "object" || !hit.key || !hit.ac) return;
    if (Date.now() - (hit.ts || 0) > SELECTED_AC_TTL_MS) {
      chrome.storage?.local?.remove(SELECTED_AC_KEY);
      return;
    }
    const id = feedCacheId();
    if (hit.centerId && id && hit.centerId !== id) return;
    selectedKey = hit.key;
    selectedAc = hit.ac;
    selectedAcSnapshot = hit.ac;
    if (hit.routeInfo !== undefined) routeInfo = hit.routeInfo;
  }

  function clearSelectedAircraftStorage() {
    chrome.storage?.local?.remove(SELECTED_AC_KEY);
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
      console.warn("[SkyDesk] syncCenter:", e);
      center = null;
    }
  }

  function ensureRootForDataLoad() {
    if (root) return true;
    if (!document.body && !document.getElementById(TAG)) return false;
    ensureMounted();
    return !!root;
  }

  function safePaint() {
    if (!ensureRootForDataLoad()) return;
    paint();
  }

  function loadRunways() {
    if (!isExtensionContextValid()) return;
    if (!ensureRootForDataLoad()) return;
    try {
      if (cfg.centerMode !== "airport" || !cfg.icao) {
        runways = [];
        terminals = [];
        airportInfo = null;
        safePaint();
        return;
      }
      const icao = cfg.icao;
      runways = [];
      safePaint();
      const req = ++runwayReq;
      chrome.runtime.sendMessage({ type: "fetch-runways", icao }, (res) => {
        drainRuntimeLastError();
        if (req !== runwayReq || cfg.icao !== icao || cfg.centerMode !== "airport") return;
        runways = res?.ok ? res.runways : [];
        safePaint();
      });
      loadTerminals();
      loadAirportInfo();
    } catch (e) {
      console.warn("[SkyDesk] loadRunways:", e);
    }
  }

  function loadAirportInfo() {
    if (!isExtensionContextValid()) return;
    if (!ensureRootForDataLoad()) return;
    try {
      if (cfg.centerMode !== "airport" || !cfg.icao) {
        airportInfo = null;
        return;
      }
      const icao = cfg.icao;
      airportInfo = null;
      const req = ++airportInfoReq;
      chrome.runtime.sendMessage({ type: "fetch-airport-info", icao }, (res) => {
        drainRuntimeLastError();
        if (req !== airportInfoReq || cfg.icao !== icao || cfg.centerMode !== "airport") return;
        airportInfo = res?.ok ? res.info : null;
        safePaint();
      });
    } catch (e) {
      console.warn("[SkyDesk] loadAirportInfo:", e);
    }
  }

  function loadTerminals() {
    if (!isExtensionContextValid()) return;
    if (!ensureRootForDataLoad()) return;
    syncCenter();
    if (cfg.centerMode !== "airport" || !cfg.icao || !center) {
      terminals = [];
      safePaint();
      return;
    }
    const icao = cfg.icao;
    const lat = center.lat;
    const lon = center.lon;
    terminals = [];
    safePaint();
    const req = ++terminalReq;
    try {
      chrome.runtime.sendMessage({ type: "fetch-terminals", icao, lat, lon }, (res) => {
        drainRuntimeLastError();
        if (req !== terminalReq || cfg.icao !== icao || cfg.centerMode !== "airport") return;
        terminals = res?.ok ? res.terminals : [];
        safePaint();
      });
    } catch (e) {
      if (isContextInvalidatedError(e)) showExtensionReloadStatus();
    }
  }

  function airportForDraw() {
    if (!center || cfg.centerMode !== "airport" || !cfg.icao) return null;
    const apt = SKCenter.airportDrawObject(
      { ...center, label: center.label || center.icao },
      runways
    );
    if (apt && isGroundActive()) {
      apt.terminals = terminals;
      apt.info = airportInfo;
    }
    return apt;
  }

  function headingLabel(deg) {
    return COMPASS[Math.round((deg || 0) / 45) % 8];
  }

  function currentSource() {
    if (trackMode || cfg.viewMode === "tracker" || tailWatch || cfg.tailWatch) return "track";
    if (pendingSource) return pendingSource;
    return cfg.centerMode === "coords" ? "coords" : "airport";
  }

  function trackKind() {
    return cfg.trackKind === "tail" ? "tail" : "flight";
  }

  // The overlay is in exactly one mode: track a flight, watch an airport, or
  // watch a lat/long. This checks the right radio and reveals its sub-panel.
  function syncHomeMarkerControls(menu) {
    if (!menu) return;
    const on = currentSource() === "coords";
    const block = menu.querySelector(".sk-home-marker-cfg");
    if (block) {
      block.classList.toggle("sk-disabled", !on);
      block.querySelectorAll("input").forEach((inp) => {
        inp.disabled = !on;
      });
    }
    const sub = menu.querySelector(".sk-home-marker-sub");
    if (sub) sub.textContent = on ? "watch center" : "lat/long only";
  }

  function syncEntitlementControls(menu) {
    menu = menu || getMenu();
    if (!menu) return;
    const coordsOk = canUseCoordsMode();
    const trackOk = canUseTrackMode();
    const bgOk = canUseBackgroundMode();

    menu.querySelectorAll(".sk-source").forEach((r) => {
      const row = r.closest(".sk-menu-row");
      const locked = r.value === "coords" ? !coordsOk : r.value === "track" ? !trackOk : false;
      if (row) row.classList.toggle("sk-disabled", locked);
      // Keep radios clickable so requireEntitlement() can start local trial / show gate feedback.
    });

    const coordsPanel = menu.querySelector(".sk-center-coords");
    if (coordsPanel) {
      const locked = !coordsOk && currentSource() !== "coords";
      coordsPanel.classList.toggle("sk-disabled", locked);
      coordsPanel.querySelectorAll("input, button").forEach((el) => {
        el.disabled = locked;
      });
    }

    const trackPanel = menu.querySelector(".sk-source-track");
    if (trackPanel) {
      const locked = !trackOk && currentSource() !== "track";
      trackPanel.classList.toggle("sk-disabled", locked);
      trackPanel.querySelectorAll("input, button").forEach((el) => {
        if (el.type !== "radio" || el.name !== "sk-track-kind") el.disabled = locked;
      });
    }

    const bgRadio = menu.querySelector('[data-cfg="displayMode"][value="background"]');
    const bgRow = bgRadio?.closest(".sk-menu-row");
    if (bgRow) bgRow.classList.toggle("sk-disabled", !bgOk);

    menu.querySelector(".sk-coords-gate-hint")?.classList.toggle("hidden", coordsOk);
    menu.querySelector(".sk-track-gate-hint")?.classList.toggle("hidden", trackOk);
    menu.querySelector(".sk-bg-gate-hint")?.classList.toggle("hidden", bgOk);
  }

  function syncCenterPanels(menu) {
    if (!menu) return;
    const src = currentSource();
    menu.querySelectorAll(".sk-source").forEach((r) => {
      r.checked = r.value === src;
    });
    menu.querySelector(".sk-center-airport")?.classList.toggle("hidden", src !== "airport");
    menu.querySelector(".sk-center-coords")?.classList.toggle("hidden", src !== "coords");
    menu.querySelector(".sk-source-track")?.classList.toggle("hidden", src !== "track");
    syncHomeMarkerControls(menu);
    syncEntitlementControls(menu);
  }

  function focusTrackInput(menu) {
    if (!menu) return;
    if (trackKind() === "tail") menu.querySelector(".sk-track-tail-input")?.focus();
    else menu.querySelector(".sk-track-flight-field .sk-track-input")?.focus();
  }

  function setSource(src) {
    const menu = getMenu();
    if (src === "track") {
      if (!canUseTrackMode()) {
        requireEntitlement().then((ok) => {
          if (!ok) {
            showGateFeedback("track");
            syncCenterPanels(menu);
            return;
          }
          setSourceTrack(menu);
        }).catch(handleContextError);
        return;
      }
      setSourceTrack(menu);
      return;
    }
    if (src === "coords" && !canUseCoordsMode()) {
      requireEntitlement().then((ok) => {
        if (!ok) {
          showGateFeedback("coords");
          syncCenterPanels(menu);
          return;
        }
        setSourceRadar(src, menu);
      }).catch(handleContextError);
      return;
    }
    setSourceRadar(src, menu);
  }

  function setSourceTrack(menu) {
    pendingSource = "track";
    syncCenterPanels(menu);

    const resumeIfEntitled = (fn) => {
      requireEntitlement().then((ok) => {
        if (!ok) {
          showGateFeedback("track");
          focusTrackInput(menu);
          return;
        }
        fn();
      }).catch(handleContextError);
    };

    if (trackKind() === "tail") {
      if (cfg.tailWatch && cfg.trackTail) resumeIfEntitled(() => resumeTailWatch());
      else if (cfg.viewMode === "tracker" && cfg.trackTail) {
        resumeIfEntitled(() => startTrackTail(cfg.trackTail, { resume: true }));
      } else focusTrackInput(menu);
    } else if (cfg.trackFlight) {
      resumeIfEntitled(() => startTrack(cfg.trackFlight));
    } else {
      focusTrackInput(menu);
    }
  }

  function setSourceRadar(src, menu) {
    pendingSource = null;
    clearFlightSelection();

    // Airport / lat-long are radar modes — leave flight tracking if it's active
    // and restore the pre-track display mode.
    const wasTracking = trackMode || cfg.viewMode === "tracker" || tailWatch || cfg.tailWatch;
    if (trackMode) {
      trackMode = false;
      stopTrackLoops();
      if (root) root.style.opacity = "";
    }
    if (tailWatch || cfg.tailWatch) {
      tailWatch = false;
      stopTailWatchPoll();
    }

    const patch = {
      viewMode: "radar",
      centerMode: src,
      trackFlight: "",
      trackTail: "",
      tailWatch: false,
      trackKind: "flight",
    };
    if (wasTracking) releaseTracker(patch);
    if (src === "coords") {
      patch.icao = "";
      patch.proGroundMode = false;
      runways = [];
      runwayReq++;
      terminals = [];
      terminalReq++;
      airportInfo = null;
      airportInfoReq++;
      const lat = SKCenter.parseCoord(menu?.querySelector(".sk-coord-lat")?.value);
      const lon = SKCenter.parseCoord(menu?.querySelector(".sk-coord-lon")?.value);
      if (SKCenter.validateLat(lat) && SKCenter.validateLon(lon)) {
        patch.centerLat = lat;
        patch.centerLon = lon;
        patch.centerLabel =
          menu?.querySelector(".sk-coord-label")?.value.trim() || SKCenter.formatCoords(lat, lon);
      }
    } else if (src === "airport" && canUseBackgroundMode() && cfg.displayMode !== "background") {
      patch.displayMode = "background";
    }
    saveCfg(patch, { immediate: true });
    syncCenterPanels(menu);
  }

  function saveCoordsFromMenu() {
    if (!canUseCoordsMode()) {
      requireEntitlement().then((ok) => {
        if (!ok) showGateFeedback("coords");
      }).catch(handleContextError);
      return;
    }
    const menu = getMenu();
    if (!menu) return;
    const lat = SKCenter.parseCoord(menu.querySelector(".sk-coord-lat")?.value);
    const lon = SKCenter.parseCoord(menu.querySelector(".sk-coord-lon")?.value);
    if (!SKCenter.validateLat(lat) || !SKCenter.validateLon(lon)) {
      showMenuStatus("Enter valid latitude (−90…90) and longitude (−180…180)");
      return;
    }
    const label =
      menu.querySelector(".sk-coord-label")?.value.trim() ||
      SKCenter.formatCoords(lat, lon);
    saveCfg({
      centerMode: "coords",
      icao: "",
      centerLat: lat,
      centerLon: lon,
      centerLabel: label,
    });
  }

  function useMyLocation() {
    const menu = getMenu();
    if (!menu || !navigator.geolocation) return;
    if (!canUseCoordsMode()) {
      requireEntitlement().then((ok) => {
        if (!ok) showGateFeedback("location");
      }).catch(handleContextError);
      return;
    }
    const btn = menu.querySelector(".sk-geo-btn");
    if (btn) btn.textContent = "Locating…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        menu.querySelector(".sk-coord-lat").value = lat.toFixed(5);
        menu.querySelector(".sk-coord-lon").value = lon.toFixed(5);
        menu.querySelector(".sk-coord-label").value = "My location";
        menu.querySelectorAll('input[name="sk-source"]').forEach((el) => {
          el.checked = el.value === "coords";
        });
        if (btn) btn.textContent = "Use my location";
        saveCfg({
          centerMode: "coords",
          icao: "",
          centerLat: lat,
          centerLon: lon,
          centerLabel: "My location",
        });
      },
      () => {
        if (btn) btn.textContent = "Use my location";
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  }

  // Fail CLOSED if entitlement.js failed to load: an unverifiable entitlement
  // must not silently unlock paid features. SKEntitlement is bundled immediately
  // before this script in the same content_scripts injection, so in practice it
  // is always present and this only closes the theoretical bypass.
  function isEntitled() {
    return window.SKEntitlement ? SKEntitlement.isActive(entitlement) : false;
  }

  function canUseCoordsMode() {
    return window.SKEntitlement ? SKEntitlement.canUseCoordsMode(entitlement) : false;
  }

  function canUseTrackMode() {
    return window.SKEntitlement ? SKEntitlement.canUseTrackMode(entitlement) : false;
  }

  function canUseBackgroundMode() {
    return window.SKEntitlement ? SKEntitlement.canUseBackgroundMode(entitlement) : false;
  }

  function overlayEnablePatch(on) {
    if (!on) return { overlay: false, enabled: false };
    const patch = { overlay: true, enabled: true };
    const wasOff = !cfg.overlay || !cfg.enabled;
    if (wasOff && canUseBackgroundMode()) patch.displayMode = "background";
    return patch;
  }

  function augmentEnablePatch(patch) {
    const turningOn =
      (patch.overlay === true || patch.enabled === true) &&
      (!cfg.overlay || !cfg.enabled) &&
      patch.overlay !== false &&
      patch.enabled !== false;
    if (!turningOn) return patch;
    const next = { ...patch, overlay: true, enabled: true };
    if (canUseBackgroundMode() && !("displayMode" in patch) && cfg.displayMode !== "background") {
      next.displayMode = "background";
    }
    return next;
  }

  function effectiveCfg() {
    if (!window.SKEntitlement) return cfg;
    return SKEntitlement.stripGatedCfg(cfg, isEntitled());
  }

  function canShiftFlightPick() {
    return mode() !== "minimized";
  }

  function flightPathTrackActive() {
    return effectiveCfg().proFlightTrack;
  }

  function shiftPickNeedsWindowCapture() {
    return visualMode() === "background";
  }

  // Shift+click picking and the flight info card are free for everyone (Free
  // tier matrix). Only the route-path fetch/draw is gated — see pickFlightAt,
  // which checks flightPathTrackActive() before fetching the route.
  function shiftFlightPickEnabled() {
    return canShiftFlightPick();
  }

  function refreshEntitlement() {
    if (!overlayActive()) {
      if (!isExtensionContextValid()) showExtensionReloadStatus();
      return Promise.resolve(entitlement);
    }
    return safeSendMessage({ type: "get-entitlement" })
      .then((res) => {
        if (!overlayActive()) {
          showExtensionReloadStatus();
          return entitlement;
        }
        try {
          entitlement = res && res.ok !== false ? res : { active: false, ok: false };
          syncSubscriptionUI();
          enforceEntitlementFallback();
          if (!isEntitled() && (trackMode || cfg.viewMode === "tracker" || tailWatch)) {
            maybeSyncTrackMode();
            paint();
          }
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
        markTrialTourPending();
        const trialRes = await safeSendMessage({ type: "open-trial" });
        if (trialRes?.localTrial && trialRes?.state) {
          entitlement = trialRes.state;
          syncSubscriptionUI();
          enforceEntitlementFallback();
          if (isEntitled()) {
            maybeOfferTrialTour();
            return true;
          }
        }
      } else {
        await safeSendMessage({ type: "open-subscription" });
      }
      showGateFeedback();
      return false;
    } catch (e) {
      if (isContextInvalidatedError(e)) {
        showExtensionReloadStatus();
        return false;
      }
      console.warn("[SkyDesk] requireEntitlement:", e);
      return false;
    }
  }

  function showMenuStatus(msg, ms = 4000) {
    const status = root?.querySelector(".sk-sub-status");
    if (!status || !msg) return;
    status.textContent = msg;
    clearTimeout(showMenuStatus._t);
    showMenuStatus._t = setTimeout(() => syncSubscriptionUI(), ms);
  }

  function showGateFeedback(feature) {
    const status = root?.querySelector(".sk-sub-status");
    if (!status) return;
    const trialAvail = !entitlement.trialStartedAt;
    if (feature === "coords" || feature === "location") {
      status.textContent = trialAvail
        ? "7-day free trial includes location watch and background mode"
        : "Subscribe to watch planes at your location";
      return;
    }
    if (feature === "background") {
      status.textContent = trialAvail
        ? "7-day free trial includes location watch and background mode"
        : "Subscribe for full background radar over any page";
      return;
    }
    if (feature === "track") {
      status.textContent = trialAvail
        ? "7-day free trial includes flight tracking"
        : "Subscribe to track flights and tail numbers";
      return;
    }
    status.textContent = trialAvail
      ? "Start your 7-day free trial to unlock this feature"
      : "Subscribe to unlock this feature";
  }

  // After a transition from inactive→active, the in-memory cfg may still hold
  // values that stripGatedCfg() downgraded (e.g. displayMode "background"→"corner"
  // at boot, before entitlement resolved). The stored sync values are untouched,
  // so re-read them and re-merge the gated keys so trial users land back in their
  // saved mode instead of being stuck in the corner.
  function reapplyGatedFromStorage() {
    if (!chrome.storage?.sync) {
      syncEntitlementControls();
      return;
    }
    chrome.storage.sync.get(DEFAULTS, (s) => {
      drainRuntimeLastError();
      const keys = new Set([
        ...(window.SKEntitlement?.GATED_CFG_KEYS || []),
        "displayMode",
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
      let changed = false;
      for (const key of keys) {
        if (key in s && cfg[key] !== s[key]) {
          cfg[key] = s[key];
          changed = true;
        }
      }
      if (changed) {
        // Values are already persisted in storage — only re-render locally.
        syncCenter();
        applyDisplayMode();
        resizeCanvas();
        syncMenuFromCfg();
        maybeSyncTrackMode();
        if (!trackMode) {
          paint();
          schedule();
        }
      }
      syncEntitlementControls();
    });
  }

  function enforceEntitlementFallback() {
    const prevEntitled = wasEntitled;
    const nowEntitled = isEntitled();
    const justActivated = nowEntitled && prevEntitled === false;
    const justExpired = !nowEntitled && prevEntitled === true;
    wasEntitled = nowEntitled;
    if (nowEntitled) {
      if (justActivated) reapplyGatedFromStorage();
      else syncEntitlementControls();
      return;
    }
    if (justExpired) {
      showMenuStatus("Your trial has ended — subscribe to keep location watch, background mode, and flight tracking.", 8000);
    }
    const stripped = effectiveCfg();
    const patch = {};
    const keys = new Set([
      ...(window.SKEntitlement?.GATED_CFG_KEYS || []),
      "centerMode",
      "displayMode",
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
      if (key in cfg && cfg[key] !== stripped[key]) patch[key] = stripped[key];
    }
    if (trackMode || tailWatch || cfg.viewMode === "tracker") {
      maybeSyncTrackMode();
    }
    if (Object.keys(patch).length) saveCfg(patch, { immediate: true });
    syncEntitlementControls();
  }

  function updateMenuPlacement() {
    const wrap = root?.querySelector(".sk-head-wrap");
    if (!wrap) return;
    if (visualMode() === "background") {
      wrap.classList.remove("sk-menu-up", "sk-menu-left");
      return;
    }
    const rect = wrap.getBoundingClientRect();
    wrap.classList.toggle("sk-menu-up", rect.bottom + 400 > innerHeight - 8);
    wrap.classList.toggle("sk-menu-left", rect.right < 296);
  }

  function savePosition() {
    if (pos.x == null || pos.y == null || !chrome.storage?.sync) return;
    chrome.storage.sync.set({ posX: pos.x, posY: pos.y });
  }

  function saveWidgetSize() {
    if (!chrome.storage?.sync) return;
    cfg.widgetSize = cornerSize();
    chrome.storage.sync.set({ widgetSize: cfg.widgetSize });
  }

  function bindResize() {
    const handle = root?.querySelector(".sk-resize");
    if (!handle || handle.dataset.bound) return;
    handle.dataset.bound = "1";

    let rs = null;
    handle.addEventListener("pointerdown", (e) => {
      if (mode() !== "corner") return;
      e.preventDefault();
      e.stopPropagation();
      rs = { x: e.clientX, y: e.clientY, size: cornerSize(), pid: e.pointerId };
      handle.setPointerCapture?.(e.pointerId);
      root.classList.add("sk-resizing");
    });
    handle.addEventListener("pointermove", (e) => {
      if (!rs || e.pointerId !== rs.pid) return;
      const delta = Math.max(e.clientX - rs.x, e.clientY - rs.y);
      widgetSize = Math.max(MIN_SIZE, Math.min(MAX_SIZE, rs.size + delta));
      resizeCanvas();
      if (pos.x != null) placeCorner(pos.x, pos.y, false);
      updateMenuPlacement();
      startRender();
    });
    const end = (e) => {
      if (!rs || e.pointerId !== rs.pid) return;
      handle.releasePointerCapture?.(e.pointerId);
      rs = null;
      root.classList.remove("sk-resizing");
      saveWidgetSize();
      paint();
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  function canDragWidget() {
    const m = mode();
    return m === "corner" || m === "minimized";
  }

  function bindDrag() {
    if (!root || root.dataset.dragBound) return;
    root.dataset.dragBound = "1";

    let drag = null;

    const onDown = (e) => {
      if (!canDragWidget()) return;
      if (e.button !== 0) return;
      if (e.shiftKey) return;
      // The dropdown grip is dragged by bindChromeDrag.
      if (e.target.closest(".sk-btn, .sk-head-trigger, .sk-gnd-btn, .sk-resize, .sk-menu, .sk-menu *")) return;

      const panelEl = root.querySelector(".sk-panel");
      const pill = root.querySelector(".sk-pill");
      const anchor = mode() === "minimized" ? pill : panelEl;
      if (!anchor) return;

      drag = {
        x: e.clientX,
        y: e.clientY,
        l: pos.x ?? anchor.offsetLeft,
        t: pos.y ?? anchor.offsetTop,
        pid: e.pointerId,
        el: e.currentTarget,
        moved: false,
      };
      root.classList.add("sk-dragging");
      drag.el.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!drag || e.pointerId !== drag.pid) return;
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
      placeCorner(drag.l + (e.clientX - drag.x), drag.t + (e.clientY - drag.y), false);
      updateMenuPlacement();
    };

    const onUp = (e) => {
      if (!drag || e.pointerId !== drag.pid) return;
      if (drag.moved) root.dataset.suppressPillClick = "1";
      drag.el.releasePointerCapture?.(e.pointerId);
      drag = null;
      root.classList.remove("sk-dragging");
      savePosition();
      updateMenuPlacement();
      if (root.dataset.suppressPillClick) {
        setTimeout(() => delete root.dataset.suppressPillClick, 0);
      }
    };

    root.querySelector(".sk-drag")?.addEventListener("pointerdown", onDown);
    root.querySelector("canvas")?.addEventListener("pointerdown", onDown);
    root.querySelector(".sk-pill")?.addEventListener("pointerdown", onDown);

    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerup", onUp);
    root.addEventListener("pointercancel", onUp);
  }

  // A position:fixed element is normally laid out relative to the viewport — but
  // if ANY ancestor has transform / filter / perspective / backdrop-filter /
  // will-change:transform / contain:paint|layout, that ancestor becomes the
  // containing block and `fixed` resolves against IT instead of the viewport.
  // The overlay is injected into arbitrary pages, so the page's own html / body /
  // wrapper frequently carries such a property. That is why the dragged dropdown
  // either refused to move or jumped off-screen (esp. in background mode, the
  // default for airport/tracker). We locate that containing block and return its
  // viewport offset so we can convert our viewport coords into its coordinate
  // space — making the float transform-immune across pages.
  function floatContainingOffset(menu) {
    let el = menu.parentElement;
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      let s;
      try {
        s = getComputedStyle(el);
      } catch (_) {
        break;
      }
      if (
        (s.transform && s.transform !== "none") ||
        (s.perspective && s.perspective !== "none") ||
        (s.filter && s.filter !== "none") ||
        (s.backdropFilter && s.backdropFilter !== "none") ||
        (s.webkitBackdropFilter && s.webkitBackdropFilter !== "none") ||
        (s.willChange && /transform|perspective|filter/.test(s.willChange)) ||
        (s.contain && /paint|layout|strict|content/.test(s.contain))
      ) {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top };
      }
      el = el.parentElement;
    }
    return { x: 0, y: 0 };
  }

  function canDragChrome() {
    return visualMode() === "background";
  }

  function syncMenuThemeVars(menu) {
    if (!menu || !root) return;
    const menuColor = root.style.getPropertyValue("--sk-menu") || cfg.colorMenu || "#2a8a42";
    menu.style.setProperty("--sk-menu", menuColor);
  }

  function dockMenuDOM() {
    const menu = getMenu();
    if (!menu) return;
    menu.classList.remove("sk-menu-floated", "sk-menu-dragging");
    const dock = root?.querySelector(".sk-head-wrap");
    if (dock && menu.parentElement !== dock) dock.appendChild(menu);
    ["position", "left", "top", "right", "bottom", "margin", "transform", "z-index"].forEach((p) =>
      menu.style.removeProperty(p)
    );
  }

  function dockTriggerDOM() {
    const trigger = getTrigger();
    if (!trigger) return;
    trigger.classList.remove("sk-trigger-floated", "sk-trigger-dragging");
    const dock = root?.querySelector(".sk-head");
    if (dock && trigger.parentElement !== dock) {
      const btns = dock.querySelector(".sk-btns");
      if (btns) dock.insertBefore(trigger, btns);
      else dock.appendChild(trigger);
    }
    ["position", "left", "top", "right", "bottom", "margin", "transform", "z-index"].forEach((p) =>
      trigger.style.removeProperty(p)
    );
  }

  // The header + dropdown are one unit. In background mode the whole chrome
  // panel can be dragged; in corner/minimized the menu grip moves the widget.
  function applyChromeFloat() {
    const wrap = root?.querySelector(".sk-head-wrap");
    if (!wrap) return;
    dockMenuDOM();
    dockTriggerDOM();
    if (!chromePos || visualMode() !== "background") {
      wrap.classList.remove("sk-chrome-floated", "sk-chrome-dragging");
      ["left", "top", "right", "bottom", "margin", "transform"].forEach((p) =>
        wrap.style.removeProperty(p)
      );
      return;
    }
    wrap.classList.add("sk-chrome-floated");
    const off = floatContainingOffset(wrap);
    wrap.style.setProperty("position", "fixed", "important");
    wrap.style.setProperty("left", `${chromePos.x - off.x}px`, "important");
    wrap.style.setProperty("top", `${chromePos.y - off.y}px`, "important");
    wrap.style.setProperty("right", "auto", "important");
    wrap.style.setProperty("bottom", "auto", "important");
    wrap.style.setProperty("margin", "0", "important");
    wrap.style.setProperty("z-index", "2147483647", "important");
  }

  function captureChromeViewportPos() {
    if (chromePos) {
      lastChromeViewportPos = { x: chromePos.x, y: chromePos.y };
      return;
    }
    const wrap = root?.querySelector(".sk-head-wrap");
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) return;
    lastChromeViewportPos = { x: rect.left, y: rect.top };
  }

  function saveChromePos() {
    cfg.chromePos = chromePos;
    cfg.triggerPos = null;
    if (!chrome.storage?.sync) return;
    chrome.storage.sync.set({ chromePos, triggerPos: null });
  }

  function bindChromeDrag() {
    if (!root || root.dataset.chromeDragBound) return;
    root.dataset.chromeDragBound = "1";

    const wrap = root.querySelector(".sk-head-wrap");
    const dragHandle = root.querySelector(".sk-drag");
    const menu = getMenu();
    const grip = menu?.querySelector(".sk-menu-grip");
    if (!wrap) return;

    let cd = null;

    const onMove = (e) => {
      if (!cd || e.pointerId !== cd.pid) return;
      const dx = e.clientX - cd.x;
      const dy = e.clientY - cd.y;
      if (Math.hypot(dx, dy) > 4) cd.moved = true;
      if (cd.chrome) {
        const w = wrap.offsetWidth;
        const h = wrap.offsetHeight;
        const nx = Math.max(4, Math.min(innerWidth - w - 4, cd.l + dx));
        const ny = Math.max(4, Math.min(innerHeight - h - 4, cd.t + dy));
        chromePos = { x: nx, y: ny };
        lastChromeViewportPos = { x: nx, y: ny };
        applyChromeFloat();
      } else if (cd.panel) {
        placeCorner(cd.l + dx, cd.t + dy, false);
        updateMenuPlacement();
      }
      e.preventDefault();
    };

    const endDrag = (e) => {
      if (!cd || (e && e.pointerId !== cd.pid)) return;
      cd.el.releasePointerCapture?.(cd.pid);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", endDrag, true);
      window.removeEventListener("pointercancel", endDrag, true);
      wrap.classList.remove("sk-chrome-dragging");
      menu?.classList.remove("sk-menu-dragging");
      root.classList.remove("sk-dragging");
      const moved = cd.moved;
      if (moved && cd.chrome) saveChromePos();
      if (moved && cd.panel) {
        savePosition();
        root.dataset.suppressPillClick = "1";
      }
      cd = null;
      updateMenuPlacement();
      if (root.dataset.suppressPillClick) {
        setTimeout(() => delete root.dataset.suppressPillClick, 0);
      }
    };

    const onDown = (e, source) => {
      if (e.button !== 0) return;
      if (source === "drag" && e.shiftKey) return;

      if (canDragChrome()) {
        const rect = wrap.getBoundingClientRect();
        cd = {
          x: e.clientX,
          y: e.clientY,
          l: rect.left,
          t: rect.top,
          pid: e.pointerId,
          el: e.currentTarget,
          chrome: true,
          moved: false,
        };
        if (!chromePos) chromePos = { x: rect.left, y: rect.top };
        wrap.classList.add("sk-chrome-dragging");
        applyChromeFloat();
      } else if (canDragWidget() && source === "grip") {
        const panelEl = root.querySelector(".sk-panel");
        const pill = root.querySelector(".sk-pill");
        const anchor = mode() === "minimized" ? pill : panelEl;
        if (!anchor) return;
        cd = {
          x: e.clientX,
          y: e.clientY,
          l: pos.x ?? anchor.offsetLeft,
          t: pos.y ?? anchor.offsetTop,
          pid: e.pointerId,
          el: e.currentTarget,
          panel: true,
          moved: false,
        };
        root.classList.add("sk-dragging");
        menu?.classList.add("sk-menu-dragging");
      } else return;

      cd.el.setPointerCapture?.(e.pointerId);
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", endDrag, true);
      window.addEventListener("pointercancel", endDrag, true);
      e.preventDefault();
      e.stopPropagation();
    };

    if (dragHandle && !dragHandle._skChromeDragBound) {
      dragHandle._skChromeDragBound = true;
      dragHandle.addEventListener("pointerdown", (e) => {
        if (!canDragChrome()) return;
        onDown(e, "drag");
      });
      dragHandle.addEventListener("dblclick", (e) => {
        if (!canDragChrome()) return;
        e.preventDefault();
        e.stopPropagation();
        chromePos = null;
        applyChromeFloat();
        saveChromePos();
        updateMenuPlacement();
      });
    }

    if (grip && !grip._skChromeDragBound) {
      grip._skChromeDragBound = true;
      grip.addEventListener("pointerdown", (e) => onDown(e, "grip"));
      grip.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (canDragChrome()) {
          chromePos = null;
          applyChromeFloat();
          saveChromePos();
        }
        updateMenuPlacement();
      });
    }
  }

  function clearFlightSelection() {
    selectedAc = null;
    selectedAcSnapshot = null;
    selectedKey = null;
    routeInfo = undefined;
    clearSelectedAircraftStorage();
    updateFlightCard();
    paint();
  }

  // ===== Flight Tracker (in-page world-map view) ==========================
  // Renders the planned route, live position and recorded trail over outlined
  // countries / US states on the widget canvas — no separate page. The active
  // flight + view persist in storage, so tracking follows you across pages.

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
        drainRuntimeLastError();
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
    chrome.storage.local.set({ [trackKey]: raw }, () => drainRuntimeLastError());
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

  // Seed the flown path from the aircraft's recorded ADS-B trace (the same
  // fetch-flight-trace data the corner-widget route path already uses) so that
  // engaging a flight already in the air shows its real prior track instead of
  // just the trail recorded since tracking started. Only runs for a fresh track
  // (no meaningful recorded trail yet), so it can never clobber points the user
  // accumulated live.
  function seedTrackFromTrace(hex, key) {
    if (!hex || !isExtensionContextValid()) return;
    if (trackModel.actual.length > 2) return;
    try {
      chrome.runtime.sendMessage({ type: "fetch-flight-trace", hex, recent: true }, (tr) => {
        drainRuntimeLastError();
        // Bail if the user switched/stopped tracking while the trace loaded.
        if (!trackMode || trackKey !== key) return;
        if (trackModel.actual.length > 2) return; // a live trail grew meanwhile
        const pts = tr?.ok && Array.isArray(tr.trace?.points) ? tr.trace.points : null;
        if (!pts || pts.length < 2) return;
        const liveTail = trackModel.actual.slice();
        const now = Date.now();
        trackModel.actual = pts.slice(-TRACK_TRAIL_CAP).map((p) => [p[0], p[1]]);
        trackStamps = trackModel.actual.map(() => now);
        // Keep any live fix recorded before the trace arrived as the newest point.
        for (const p of liveTail) {
          const last = trackModel.actual[trackModel.actual.length - 1];
          if (!last || last[0] !== p[0] || last[1] !== p[1]) {
            trackModel.actual.push(p);
            trackStamps.push(now);
          }
        }
        saveTrackTrail();
        drawTrackCanvas();
      });
    } catch (e) {
      if (isContextInvalidatedError(e)) showExtensionReloadStatus();
    }
  }

  function trackRouteSummary() {
    const dep = trackModel.dep;
    const arr = trackModel.arr;
    const depTxt = dep ? `${dep.iata || dep.icao || "?"}` : "Unknown origin";
    const arrTxt = arr ? `${arr.iata || arr.icao || "?"}` : "Unknown destination";
    return `${depTxt} → ${arrTxt}`;
  }

  function renderTrackStatus() {
    const el = root?.querySelector(".sk-track-status");
    if (!el) return;
    el.textContent = trackStatusText
      ? `${trackStatusText} — ${trackRouteSummary()}`
      : "";
  }

  function syncTrackUI() {
    const menu = getMenu();
    if (!menu) return;
    const kind = trackKind();
    menu.querySelectorAll(".sk-track-kind").forEach((r) => {
      if (r !== document.activeElement) r.checked = r.value === kind;
    });
    menu.querySelector(".sk-track-flight-field")?.classList.toggle("hidden", kind !== "flight");
    menu.querySelector(".sk-track-tail-field")?.classList.toggle("hidden", kind !== "tail");

    const input = menu.querySelector(".sk-track-input");
    const tailInput = menu.querySelector(".sk-track-tail-input");
    const btn = menu.querySelector(".sk-track-btn");
    const stop = menu.querySelector(".sk-track-stop");
    if (input && input !== document.activeElement && cfg.trackFlight) {
      input.value = cfg.trackFlight;
    }
    if (tailInput && tailInput !== document.activeElement && cfg.trackTail) {
      tailInput.value = cfg.trackTail;
    }
    const active = trackMode || tailWatch || cfg.tailWatch;
    if (btn) btn.textContent = active ? "Retrack" : "Track";
    stop?.classList.toggle("hidden", !active);
    renderTrackStatus();
  }

  function startTailWatchPoll() {
    clearInterval(tailWatchPoll);
    tailWatchPoll = setInterval(() => {
      if (!overlayActive()) {
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

  function resumeTailWatch() {
    if (!cfg.trackTail) return;
    tailWatch = true;
    trackStatusText = `Waiting for ${cfg.trackTail}…`;
    syncTrackUI();
    startTailWatchPoll();
    tryEngageTail(cfg.trackTail);
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

  // When tracking from lat/long radar, the plane may be in our local feed before
  // the global callsign lookup returns — pass its fix for route plausibility.
  function localLiveHintForFlight(flight) {
    const norm = String(flight || "").trim().toUpperCase().replace(/[\s-]/g, "");
    if (!norm) return null;
    const hit = aircraft.find((a) => {
      const fl = String(a.flight || "").trim().toUpperCase().replace(/[\s-]/g, "");
      return fl && (fl === norm || fl.endsWith(norm) || norm.endsWith(fl));
    });
    return hit?.lat != null ? acToLive(hit) : null;
  }

  function tryEngageTail(tail) {
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
            renderTrackStatus();
          }
          return;
        }
        if (res.waiting || !res.live) {
          if (tailWatch || cfg.tailWatch) {
            trackStatusText = `Waiting for ${norm}…`;
            renderTrackStatus();
          }
          return;
        }
        const patch = {
          viewMode: "tracker",
          tailWatch: false,
          trackTail: norm,
          trackKind: "tail",
          trackFlight: "",
        };
        containTracker(patch);
        saveCfg(patch, { immediate: true });
        const mapOk = await ensureWorldData();
        if (!mapOk) return;
        await engageTrackResponse(res, norm, { kind: "tail" });
      });
    } catch (e) {
      trackBusy = false;
      if (isContextInvalidatedError(e)) {
        stopTailWatchPoll();
        showExtensionReloadStatus();
      }
    }
  }

  function startTrackLoops() {
    clearInterval(trackPoll);
    clearInterval(trackPulse);
    trackPoll = setInterval(pollTrack, TRACK_POLL_MS);
    trackPulse = setInterval(drawTrackCanvas, TRACK_PULSE_MS);
  }

  function stopTrackLoops() {
    clearInterval(trackPoll);
    clearInterval(trackPulse);
    trackPoll = null;
    trackPulse = null;
  }

  // Canvas-only render of the world map, honoring the current display mode's
  // canvas size / DPR transform.
  function drawTrackCanvas() {
    if (!overlayActive()) return;
    if (!trackMode || !root) return;
    const m = visualMode();
    if (m === "minimized") return;
    const canvas = root.querySelector("canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = m === "background" ? innerWidth : cornerSize();
    const h = m === "background" ? innerHeight : cornerSize();
    if (m === "background") {
      const dpr = devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    if (worldReady && window.SKWorldMap) {
      SKWorldMap.draw(ctx, w, h, trackModel, performance.now(), {
        backdropAlpha: Math.min(1, (cfg.trackerOpacity ?? 75) / 100),
      });
    }
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

  // resume=true is used when re-attaching to an already-active flight (e.g. on a
  // newly loaded page) — it skips re-persisting cfg and stays quiet on failure.
  async function engageTrackResponse(res, label, opts = {}) {
    const dep = res.route ? await resolveTrackCoords(res.route.dep) : null;
    const arr = res.route ? await resolveTrackCoords(res.route.arr) : null;
    trackModel = { dep, arr, live: res.live || null, planned: [], actual: [] };
    trackStamps = [];
    buildTrackPlanned();

    // Canonical trail key: the user-facing flight/tail label. restoreTrackPreview()
    // (cross-page resume) only has the label — keying on res.live.hex here would
    // save the trail under a key the resume path can never reconstruct, so the
    // trail would appear lost after a navigation.
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
    // Pause the radar feed + sweep while the map view is up.
    clearTimeout(timer);
    cancelAnimationFrame(animId);
    animId = null;

    trackStatusText = res.live
      ? `Tracking ${res.callsign || label}`
      : `Route for ${res.callsign || label} · not currently live`;

    // Containment (background -> contained corner widget) is folded into the
    // track-start patch by the callers, so by the time we get here displayMode
    // is already settled — just apply it.
    applyDisplayMode();
    resizeCanvas();
    drawTrackCanvas();
    renderTrackStatus();
    syncTrackUI();
    applyTrackerOpacity();
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
      const btn = root?.querySelector(".sk-track-btn");
      if (btn) btn.disabled = true;
      trackStatusText = "";
      const st = root?.querySelector(".sk-track-status");
      if (st) st.textContent = "Searching…";
    }

    const ok = await ensureWorldData();
    if (!ok) {
      trackBusy = false;
      const btn = root?.querySelector(".sk-track-btn");
      if (btn) btn.disabled = false;
      const st = root?.querySelector(".sk-track-status");
      if (st) st.textContent = "Map data failed to load.";
      return;
    }

    if (!opts.resume) {
      clearFlightSelection();
      tailWatch = false;
      stopTailWatchPoll();
      const patch = {
        viewMode: "tracker",
        trackFlight: flight,
        trackTail: "",
        trackKind: "flight",
        tailWatch: false,
      };
      containTracker(patch);
      saveCfg(patch, { immediate: true });
    }

    if (!isExtensionContextValid()) {
      trackBusy = false;
      const btn = root?.querySelector(".sk-track-btn");
      if (btn) btn.disabled = false;
      showExtensionReloadStatus();
      return;
    }
    try {
      chrome.runtime.sendMessage(
        { type: "fetch-flight", flight, liveHint: localLiveHintForFlight(flight) },
        async (res) => {
          drainRuntimeLastError();
          trackBusy = false;
          const btn = root?.querySelector(".sk-track-btn");
          if (btn) btn.disabled = false;

          if (!res || !res.ok) {
            const st = root?.querySelector(".sk-track-status");
            if (st) st.textContent = res?.error || "Flight not found or not currently tracked.";
            if (!trackMode && !opts.resume) {
              const revert = { viewMode: "radar" };
              releaseTracker(revert);
              saveCfg(revert, { immediate: true });
            }
            return;
          }

          await engageTrackResponse(res, flight, { kind: "flight" });
        }
      );
    } catch (e) {
      trackBusy = false;
      const btn = root?.querySelector(".sk-track-btn");
      if (btn) btn.disabled = false;
      if (isContextInvalidatedError(e)) showExtensionReloadStatus();
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
      const btn = root?.querySelector(".sk-track-btn");
      if (btn) btn.disabled = true;
      trackStatusText = "";
      const st = root?.querySelector(".sk-track-status");
      if (st) st.textContent = "Searching…";
    }

    const ok = await ensureWorldData();
    if (!ok) {
      trackBusy = false;
      const btn = root?.querySelector(".sk-track-btn");
      if (btn) btn.disabled = false;
      const st = root?.querySelector(".sk-track-status");
      if (st) st.textContent = "Map data failed to load.";
      return;
    }

    if (!opts.resume) {
      clearFlightSelection();
      tailWatch = true;
      trackStatusText = `Waiting for ${tail}…`;
      saveCfg({
        trackKind: "tail",
        trackTail: tail,
        trackFlight: "",
        tailWatch: true,
        viewMode: "radar",
      }, { immediate: true });
      syncTrackUI();
      startTailWatchPoll();
      tryEngageTail(tail);
      const btn = root?.querySelector(".sk-track-btn");
      if (btn) btn.disabled = false;
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
        drainRuntimeLastError();
        trackBusy = false;
        if (!res?.ok) {
          if (!tailWatch) resumeTailWatch();
          return;
        }
        if (res.waiting || !res.live) {
          if (!tailWatch) resumeTailWatch();
          return;
        }

        const patch = { viewMode: "tracker", tailWatch: false, trackTail: tail, trackKind: "tail" };
        containTracker(patch);
        saveCfg(patch, { immediate: true });
        const mapOk = await ensureWorldData();
        if (!mapOk) return;
        await engageTrackResponse(res, tail, { kind: "tail" });
      });
    } catch (e) {
      trackBusy = false;
      if (isContextInvalidatedError(e)) showExtensionReloadStatus();
    }
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
    // Keep the last-known dep/arr when a poll omits route data — a transient
    // lookup miss shouldn't wipe a good route from the initial engage.
  }

  function pollTrack() {
    // After an extension reload/update the old content script keeps running but
    // chrome.runtime.id is gone; sendMessage then throws "Extension context
    // invalidated" on every tick. Stop the loops and bail.
    if (!overlayActive()) {
      showExtensionReloadStatus();
      return;
    }
    if (!trackMode) return;
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
      trackStatusText = res.live
        ? `Tracking ${res.callsign || label}`
        : `Route for ${res.callsign || label} · not currently live`;
      renderTrackStatus();
      applyTrackRouteFromPoll(res).then(() => {
        if (trackMode) drawTrackCanvas();
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
      clearFlightSelection();
      const patch = {
        viewMode: "radar",
        trackFlight: "",
        trackTail: "",
        tailWatch: false,
        trackKind: "flight",
      };
      releaseTracker(patch);
      saveCfg(patch, { immediate: true });
    }
    syncTrackUI();
    if (root) {
      root.style.opacity = "";
      const c = root.querySelector("canvas");
      if (c) c.style.opacity = "";
    }
    applyDisplayMode();
    resizeCanvas();
    paint();
    schedule();
    startRender();
  }

  // The flight tracker renders INSIDE the corner radar widget so it never greys
  // out or takes over the whole page. If the user is in full-page background
  // mode, drop to the contained corner widget for the duration of the track
  // (remembering background so releaseTracker can restore it).
  //
  // This MUTATES the caller's cfg patch instead of issuing its own write: the
  // containment must travel in the SAME atomic storage write that starts the
  // track. A separate immediate saveCfg here raced the first write's
  // storage.onChanged echo — only one of the two near-simultaneous writes got
  // skipped, so the other triggered a redundant re-entrant apply()/startTrack,
  // which broke starting a track from full background mode.
  function containTracker(patch) {
    if (cfg.displayMode === "background") {
      patch.preTrackDisplayMode = "background";
      patch.displayMode = "corner";
    }
    return patch;
  }

  // Mutates `patch` to restore the pre-track display mode (e.g. back to
  // full-page background) and clears the saved override.
  function releaseTracker(patch) {
    if (cfg.preTrackDisplayMode === "background" && cfg.displayMode !== "background") {
      patch.displayMode = "background";
    }
    patch.preTrackDisplayMode = "";
  }

  function applyTrackerOpacity() {
    if (!root) return;
    // Tracker opacity now drives the world-map backdrop alpha inside the canvas
    // (see drawTrackCanvas / SKWorldMap.draw), NOT the opacity of the whole
    // overlay. Applying it to `root` previously dimmed the entire web page and
    // faded the aircraft/route along with the backdrop. Clear any legacy element
    // opacity and repaint so the new backdrop alpha takes effect immediately.
    root.style.opacity = "";
    const canvas = root.querySelector("canvas");
    if (canvas) canvas.style.opacity = "";
    if (trackMode && visualMode() !== "minimized") drawTrackCanvas();
  }

  // Reconcile the live tracker with persisted cfg (called from apply()) so the
  // tracker resumes automatically when a fresh page loads with tracking active,
  // and stops when another tab turns it off.
  async function restoreTrackPreview() {
    if (cfg.viewMode !== "tracker" || !isEntitled()) return false;
    const label = trackKind() === "tail" ? cfg.trackTail : cfg.trackFlight;
    if (!label) return false;

    const ok = await ensureWorldData();
    if (!ok) return false;

    trackKey = `trackerTrail:${label}`;
    const trail = await loadTrackTrail(trackKey);
    const last = trail.pts[trail.pts.length - 1];
    trackModel = {
      dep: null,
      arr: null,
      live: last ? { lat: last[1], lon: last[0] } : null,
      planned: [],
      actual: trail.pts,
    };
    trackStamps = trail.ts;
    trackMode = true;
    trackStatusText = `Resuming ${label}…`;
    clearTimeout(timer);
    cancelAnimationFrame(animId);
    animId = null;
    // Resume path: persist containment only if needed (e.g. legacy state that
    // still has displayMode=background). This is a lone write here, so it can't
    // race a competing track-start write the way the old in-engage call did.
    const containPatch = containTracker({});
    if (containPatch.displayMode) saveCfg(containPatch, { immediate: true });
    applyDisplayMode();
    resizeCanvas();
    drawTrackCanvas();
    renderTrackStatus();
    syncTrackUI();
    applyTrackerOpacity();
    startTrackLoops();
    // Poll once immediately so the route/live position populate now instead of
    // showing a blank map until the first TRACK_POLL_MS tick (~12s).
    pollTrack();
    paint();
    return true;
  }

  function maybeSyncTrackMode() {
    if ((cfg.viewMode === "tracker" || cfg.tailWatch) && !isEntitled()) {
      if (trackMode || tailWatch || cfg.viewMode === "tracker") clearTrack({ keepCfg: false });
      return;
    }
    if (cfg.viewMode === "tracker") {
      if (trackKind() === "tail" && cfg.trackTail) {
        if (!trackBusy) startTrackTail(cfg.trackTail, { resume: true });
      } else if (cfg.trackFlight) {
        if (!trackBusy) startTrack(cfg.trackFlight, { resume: true });
      }
    } else if (cfg.tailWatch && cfg.trackTail) {
      if (!tailWatch) resumeTailWatch();
    } else {
      if (trackMode) clearTrack({ keepCfg: true });
      if (tailWatch) {
        tailWatch = false;
        stopTailWatchPoll();
      }
    }
  }

  function resolveSelected(list) {
    if (!selectedKey) return null;
    const live =
      list?.find((a) => SKRadar.acKey(a) === selectedKey) ||
      aircraft.find((a) => SKRadar.acKey(a) === selectedKey) ||
      null;
    if (live) {
      selectedAcSnapshot = live;
      return live;
    }
    if (selectedAcSnapshot && SKRadar.acKey(selectedAcSnapshot) === selectedKey) {
      return selectedAcSnapshot;
    }
    return null;
  }

  function updateFlightCard() {
    const card = root?.querySelector(".sk-flight-card");
    if (!card) return;
    if (!selectedAc) {
      card.classList.add("hidden");
      setHTML(card, "");
      return;
    }
    const info = SKRadar.formatFlightCard(selectedAc, routeInfo);
    const emg = effectiveCfg().showEmergency !== false ? SKRadar.emergencyInfo(selectedAc) : null;
    card.classList.toggle("sk-emerg", !!emg);
    card.classList.remove("hidden");
    const emgLine = emg
      ? `<span class="sk-emerg-line">⚠ ${esc(emg.label)}${emg.code && emg.code !== "EMG" ? ` · SQ ${esc(emg.code)}` : ""}</span>`
      : "";
    const pathGated = cfg.proFlightTrack && !flightPathTrackActive();
    const footer = pathGated
      ? "Route path on radar requires subscription · Shift+click to clear"
      : "Shift+click empty sky or same plane to clear";
    setHTML(
      card,
      `<strong>${esc(info.title)}</strong>${emgLine}${info.lines.map((l) => `<span>${esc(l)}</span>`).join("")}<em>${esc(footer)}</em>`
    );
  }

  function fetchRouteFor(ac) {
    if (!isExtensionContextValid() || !ac) return;
    const key = SKRadar.acKey(ac);
    routeInfo = null;
    updateFlightCard();
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
          routeInfo = res?.ok ? { ...res.route } : false;
          saveSelectedAircraft();
          updateFlightCard();
          paint();
          if (ac.hex && routeInfo) {
            try {
              chrome.runtime.sendMessage(
                { type: "fetch-flight-trace", hex: ac.hex, recent: true },
                (tr) => {
                  drainRuntimeLastError();
                  if (selectedKey !== key) return;
                  if (!routeInfo) return;
                  if (tr?.ok && tr.trace?.points?.length > 1) {
                    routeInfo.trace = tr.trace.points;
                    saveSelectedAircraft();
                    paint();
                  }
                }
              );
            } catch (e) {
              if (isContextInvalidatedError(e)) showExtensionReloadStatus();
            }
          }
        }
      );
    } catch (e) {
      if (isContextInvalidatedError(e)) showExtensionReloadStatus();
    }
  }

  function pickFlightAt(clientX, clientY) {
    if (!shiftFlightPickEnabled()) return;
    const canvas = root?.querySelector("canvas");
    const radius = visualMode() === "background" ? 18 : 22;
    const hit = SKRadar.hitTestClient(
      lastDrawList,
      canvas,
      clientX,
      clientY,
      radius,
      lastDrawW,
      lastDrawH
    );
    const hitKey = hit ? SKRadar.acKey(hit) : null;
    if (hitKey && hitKey === selectedKey) {
      clearFlightSelection();
      return;
    }
    selectedKey = hitKey;
    selectedAc = hit;
    selectedAcSnapshot = hit;
    routeInfo = undefined;
    saveSelectedAircraft();
    updateFlightCard();
    if (hit) {
      // Info card always shows. The route path on the radar is the pro feature —
      // only fetch/draw it when flight-path tracking is actually active.
      if (flightPathTrackActive()) {
        fetchRouteFor(hit);
      } else if (cfg.proFlightTrack) {
        showGateFeedback();
      }
    }
    paint();
  }

  function bindCanvasInput() {
    const canvas = root?.querySelector("canvas");
    if (!canvas || canvas.dataset.skInput) return;
    canvas.dataset.skInput = "1";

    canvas.addEventListener(
      "pointerdown",
      (e) => {
        if (e.button !== 0) return;
        if (e.shiftKey) {
          if (shiftFlightPickEnabled() && !shiftPickNeedsWindowCapture()) {
            e.preventDefault();
            e.stopImmediatePropagation();
            pickFlightAt(e.clientX, e.clientY);
          }
          return;
        }
      },
      true
    );
  }

  function bindFlightPick() {
    if (!root) return;
    // Canvas listener is per-canvas (bindCanvasInput self-guards on the canvas),
    // so it correctly rebinds to a freshly-mounted canvas.
    bindCanvasInput();
    // The window-level shift-pick + Escape handlers must be attached exactly once
    // for the page lifetime, regardless of how many times the widget remounts.
    if (flightPickWindowBound) return;
    flightPickWindowBound = true;

    window.addEventListener(
      "pointerdown",
      (e) => {
        if (!e.shiftKey || !shiftFlightPickEnabled() || !shiftPickNeedsWindowCapture()) return;
        if (e.target.closest(".sk-menu, #skydesk-root .sk-flight-card, #skydesk-root .sk-head-wrap")) {
          return;
        }
        const canvas = root.querySelector("canvas");
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        if (
          e.clientX < rect.left ||
          e.clientX > rect.right ||
          e.clientY < rect.top ||
          e.clientY > rect.bottom
        ) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        pickFlightAt(e.clientX, e.clientY);
      },
      true
    );
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && selectedKey) clearFlightSelection();
    });
  }

  function mode() {
    return MODES.includes(cfg.displayMode) ? cfg.displayMode : "corner";
  }

  function saveMode(nextMode) {
    closeMenu();
    saveCfg({ displayMode: nextMode }, { immediate: true });
  }

  function commitCfg() {
    clearTimeout(commitTimer);
    commitTimer = null;
    const patch = pendingPatch;
    pendingPatch = {};
    if (!chrome.storage?.sync || !Object.keys(patch).length) return;
    // We already applied this change locally; skip the storage.onChanged echo
    // so this tab doesn't re-run apply()/refetch for its own write.
    skipNextSync = true;
    chrome.storage.sync.set(patch);
  }

  function scheduleCommit() {
    clearTimeout(commitTimer);
    commitTimer = setTimeout(commitCfg, 350);
  }

  function scheduleReschedule() {
    clearTimeout(rescheduleTimer);
    rescheduleTimer = setTimeout(() => {
      rescheduleTimer = null;
      schedule();
    }, 400);
  }

  // Cross-tab sync is handled by chrome.storage.onChanged; we intentionally do
  // NOT broadcast a settings-updated message here, to avoid the originating tab
  // applying its own change twice. Writes are coalesced to respect the
  // chrome.storage.sync write-rate quota during slider/color drags.
  function saveCfg(patch, opts = {}) {
    patch = augmentEnablePatch(patch);
    if (patch.displayMode === "minimized" && mode() !== "minimized") {
      lastNonMinMode = mode();
    }
    cfg = { ...cfg, ...patch };
    Object.assign(pendingPatch, patch);

    const centerChanged =
      "icao" in patch || "centerLat" in patch || "centerLon" in patch || "centerMode" in patch;
    const needsReschedule =
      centerChanged || "refreshSec" in patch || "proGroundMode" in patch || "rangeNm" in patch;

    if ("showSweep" in patch || "proGroundMode" in patch) startAnim();
    if ("displayMode" in patch || "proGroundMode" in patch) applyDisplayMode();
    if ("overlay" in patch) {
      if (!cfg.overlay) {
        closeMenu();
        clearTimeout(timer);
        cancelAnimationFrame(animId);
      } else {
        ensureMounted();
        startAnim();
      }
    }
    if (centerChanged) {
      syncCenter();
      initialFetchDone = false;
      lastFeedSig = "";
      loadRunways();
    }

    paint();

    if (opts.immediate) {
      commitCfg();
      if (needsReschedule || "overlay" in patch) schedule();
    } else {
      scheduleCommit();
      if (needsReschedule || "overlay" in patch) scheduleReschedule();
    }
  }

  function closeMenu() {
    captureChromeViewportPos();
    const wrap = root?.querySelector(".sk-head-wrap");
    const menu = getMenu();
    wrap?.classList.remove("sk-open");
    menu?.classList.add("hidden");
  }

  function toggleMenu() {
    const wrap = root?.querySelector(".sk-head-wrap");
    const menu = getMenu();
    if (!wrap || !menu) return;
    const open = menu.classList.toggle("hidden");
    wrap.classList.toggle("sk-open", !open);
    getTrigger()?.classList.toggle("sk-open", !open);
    if (!open) {
      bindChromeDrag();
      updateMenuPlacement();
    }
  }

  function syncSubscriptionUI() {
    const menu = getMenu();
    if (!menu) return;
    const status = menu.querySelector(".sk-sub-status");
    const trialBtn = menu.querySelector('[data-action="trial"]');
    const subBtn = menu.querySelector('[data-action="subscription"]');
    if (status && window.SKEntitlement) {
      status.textContent = SKEntitlement.statusLabel(entitlement);
    }
    const active = isEntitled();
    trialBtn?.classList.toggle("hidden", active || !!entitlement.trialStartedAt);
    if (subBtn) {
      subBtn.textContent = entitlement.paid ? "Manage subscription" : "Subscribe · $2.99/mo or $24.99/yr";
    }
  }

  function syncMenuFromCfg() {
    const menu = getMenu();
    if (!menu) return;

    // Re-syncing controls (and the layout work that runs alongside this on every
    // change/refresh) can bump the scroll container back to the top. Preserve it,
    // and never overwrite the control the user is actively touching.
    const prevScroll = menu.scrollTop;
    const active = document.activeElement;

    menu.querySelectorAll("[data-cfg]").forEach((el) => {
      if (el === active) return;
      const key = el.dataset.cfg;
      if (el.type === "checkbox") {
        el.checked = key === "showTagBg" || key === "showRangeRings" || key === "showOuterRing" || key === "showRunways" || key === "showAirportDot" || key === "showHomeMarker"
          || key === "showOverheadHighlight"
          ? cfg[key] !== false
          : !!cfg[key];
      }
      else if (el.type === "radio") el.checked = String(cfg[key]) === el.value;
      else if (el.tagName === "INPUT" || el.tagName === "SELECT") el.value = cfg[key];
    });

    const tagVal = menu.querySelector(".sk-tag-font-val");
    if (tagVal) tagVal.textContent = `${cfg.tagFontSize}px`;
    const opVal = menu.querySelector(".sk-opacity-val");
    if (opVal) opVal.textContent = `${cfg.opacity}%`;
    const rngVal = menu.querySelector(".sk-range-val");
    if (rngVal) rngVal.textContent = `${cfg.rangeNm} nm`;
    const headVal = menu.querySelector(".sk-heading-val");
    if (headVal) headVal.textContent = headingLabel(cfg.heading);
    const refVal = menu.querySelector(".sk-refresh-val");
    if (refVal) refVal.textContent = `${cfg.refreshSec || 2}s`;
    const feedSt = menu.querySelector(".sk-feed-status");
    if (feedSt) syncFeedStatus(feedSt);
    const ringOpVal = menu.querySelector(".sk-ring-opacity-val");
    if (ringOpVal) ringOpVal.textContent = `${cfg.ringOpacity ?? 100}%`;
    const homeOpVal = menu.querySelector(".sk-home-marker-op-val");
    if (homeOpVal) homeOpVal.textContent = `${cfg.homeMarkerOpacity ?? 90}%`;
    const wxOpVal = menu.querySelector(".sk-weather-op-val");
    if (wxOpVal) wxOpVal.textContent = `${cfg.weatherOpacity ?? 70}%`;
    const terOpVal = menu.querySelector(".sk-terrain-op-val");
    if (terOpVal) terOpVal.textContent = `${cfg.terrainOpacity ?? 60}%`;
    const watOpVal = menu.querySelector(".sk-water-op-val");
    if (watOpVal) watOpVal.textContent = `${cfg.waterOpacity ?? 70}%`;
    const trkOpVal = menu.querySelector(".sk-tracker-op-val");
    if (trkOpVal) trkOpVal.textContent = `${cfg.trackerOpacity ?? 75}%`;
    const grVal = menu.querySelector(".sk-ground-range-val");
    if (grVal) grVal.textContent = `${cfg.groundRangeNm ?? 2.5} nm`;
    syncTrackUI();

    const aptQ = menu.querySelector(".sk-apt-q");
    if (aptQ && aptQ !== active) aptQ.value = cfg.centerMode === "airport" ? (cfg.icao || "") : "";

    const latIn = menu.querySelector(".sk-coord-lat");
    const lonIn = menu.querySelector(".sk-coord-lon");
    const lblIn = menu.querySelector(".sk-coord-label");
    if (latIn && latIn !== active && cfg.centerLat != null) latIn.value = String(cfg.centerLat);
    if (lonIn && lonIn !== active && cfg.centerLon != null) lonIn.value = String(cfg.centerLon);
    if (lblIn && lblIn !== active) lblIn.value = cfg.centerLabel || "";

    syncCenterPanels(menu);
    syncGroundBtn();
    const groundRow = menu.querySelector(".sk-pro-ground");
    if (groundRow) {
      const on = canUseGroundMode();
      groundRow.classList.toggle("sk-disabled", !on);
      const inp = groundRow.querySelector("input");
      if (inp) {
        inp.disabled = !on;
        if (!on) inp.checked = false;
      }
    }

    if (menu.scrollTop !== prevScroll) menu.scrollTop = prevScroll;
    syncSubscriptionUI();
    applyChromeFloat();
  }

  function aptBadge(ap) {
    if (ap.airspace === "B") return "B";
    if (ap.airspace === "C") return "C";
    if (ap.airspace === "INTL") return "INTL";
    if (ap.airspace === "INTL-R") return "REG";
    return "";
  }

  // Monotonic sequence so a slow/out-of-order async search response can never
  // overwrite the list with stale rows (which would swap the row out from under
  // the user's cursor right as they click).
  let aptSearchSeq = 0;
  // Timestamp of the last commit. The field's focus/click handlers consult this
  // so the list cannot immediately re-open after a pick (which made selections
  // look like they "didn't take").
  let aptPickedAt = 0;

  function aptSuppressed() {
    return Date.now() - aptPickedAt < 400;
  }

  // Single entry point for issuing a search. Wrapping the callback with the
  // captured sequence number drops responses that arrive after a newer query
  // (or after a pick) instead of re-rendering the dropdown on top of them.
  function runAptSearch(q) {
    const seq = ++aptSearchSeq;
    SK_searchAirportsAsync(q, 10, (hits) => {
      if (seq !== aptSearchSeq || aptSuppressed()) return;
      renderAptSuggest(hits);
    });
  }

  function bindAptSuggest(menu) {
    const ul = menu?.querySelector(".sk-apt-suggest");
    if (!ul || ul.dataset.bound) return;
    ul.dataset.bound = "1";
    // Delegated on the persistent <ul> (its innerHTML is replaced per keystroke,
    // but the element — and this listener — survives). Commit on pointerdown so
    // the choice is locked in before the input's blur / any trailing click can
    // dismiss the list; preventDefault keeps focus on the input so it never
    // blurs the list away, and closest("li") makes the whole row (incl. its
    // text/badge children) a single hit target.
    const commit = (e) => {
      const li = e.target.closest("li[data-icao]");
      if (!li) return;
      e.preventDefault();
      e.stopPropagation();
      pickAirportFromMenu(li.dataset.icao);
    };
    ul.addEventListener("pointerdown", commit);
    // Swallow the trailing click from the same press so it can't bubble to the
    // field/menu/document handlers (which would refocus the input and re-open
    // the suggestions, or close the menu).
    ul.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }

  function renderAptSuggest(hits) {
    const menu = getMenu();
    const ul = menu?.querySelector(".sk-apt-suggest");
    if (!ul) return;
    bindAptSuggest(menu);
    setHTML(ul, hits
      .map((a) => {
        const b = aptBadge(a);
        const tag = b ? `<em class="sk-apt-badge">${esc(b)}</em>` : "";
        return `<li data-icao="${esc(a.icao)}">${esc(a.icao)}${a.iata ? ` / ${esc(a.iata)}` : ""} — ${esc(a.name)} ${tag}</li>`;
      })
      .join(""));
    ul.classList.toggle("hidden", !hits.length);
  }

  function pickAirportFromMenu(icao) {
    // Lock the list immediately (the async lookup below resolves a tick later):
    // hide it, mark the suppress window, and invalidate any in-flight search so
    // nothing re-renders or re-opens the dropdown while we commit.
    aptPickedAt = Date.now();
    aptSearchSeq++;
    root?.querySelector(".sk-apt-suggest")?.classList.add("hidden");
    SK_getAirportAsync(icao, (ap) => {
      if (!ap) {
        showMenuStatus(`Airport not found: ${(icao || "").trim().toUpperCase() || "?"}`);
        return;
      }
      const menu = getMenu();
      const q = menu?.querySelector(".sk-apt-q");
      const ul = menu?.querySelector(".sk-apt-suggest");
      if (q) q.value = ap.icao;
      ul?.classList.add("hidden");
      menu?.querySelectorAll('input[name="sk-source"]').forEach((el) => {
        el.checked = el.value === "airport";
      });
      syncCenterPanels(menu);
      runways = [];
      terminals = [];
      airportInfo = null;
      runwayReq++;
      terminalReq++;
      airportInfoReq++;
      saveCfg({
        centerMode: "airport",
        icao: ap.icao,
        centerLat: ap.lat,
        centerLon: ap.lon,
        centerLabel: ap.icao,
        ...(canUseBackgroundMode() && cfg.displayMode !== "background"
          ? { displayMode: "background" }
          : {}),
      }, { immediate: true });
    });
  }

  function helpModalHtml() {
    return `<div class="sk-help-modal hidden" role="dialog" aria-labelledby="sk-help-title" aria-modal="true">
      <div class="sk-help-backdrop"></div>
      <div class="sk-help-panel">
        <div class="sk-help-header">
          <h2 id="sk-help-title">How to use SkyDesk</h2>
          <button type="button" class="sk-help-close" title="Close" aria-label="Close">×</button>
        </div>
        <div class="sk-help-body">
          <section class="sk-help-section">
            <h3>Getting started</h3>
            <ul>
              <li>Install SkyDesk and <strong>pin the extension</strong> in Chrome&apos;s toolbar (puzzle icon → pin).</li>
              <li>Open any normal website — not Chrome&apos;s New Tab or <code>chrome://</code> pages.</li>
              <li>The radar widget appears (default: full background, centered on Detroit Metro / <strong>DTW</strong>).</li>
              <li>Open the menu via <strong>SkyDesk ▾</strong> on the widget header, the <strong>⋮⋮</strong> grip, or the toolbar popup with <strong>Radar on pages</strong> enabled.</li>
            </ul>
          </section>
          <section class="sk-help-section">
            <h3>Modes</h3>
            <p>SkyDesk is in one watch or track mode at a time (Menu → <strong>Mode</strong>).</p>
            <ul>
              <li><strong>Watch an airport</strong> — Search ICAO, IATA, or name (e.g. DTW, LAX, EGLL). Pick from suggestions. Free forever in the corner widget; full background when subscribed. US airports show <strong>B</strong>/<strong>C</strong> badges; international hubs show <strong>INTL</strong> or <strong>REG</strong>.</li>
              <li><strong>Watch a latitude / longitude</strong> — Enter LAT/LONG and an optional label, or click <strong>Use my location</strong>. Requires an active trial or subscription.</li>
              <li><strong>Track a flight</strong> — Enter a <strong>flight number</strong> (e.g. DAL123, DL123) or <strong>tail number</strong> (e.g. N12345, G-ABCD), then click <strong>Track</strong>. Requires an active trial or subscription.</li>
            </ul>
          </section>
          <section class="sk-help-section">
            <h3>Display</h3>
            <ul>
              <li><strong>Corner widget</strong> — Square radar you can drag and resize (150–560 px via the bottom-right handle).</li>
              <li><strong>Full background</strong> — Semi-transparent radar over the whole page. Requires an active trial or subscription.</li>
              <li><strong>Minimized</strong> — Small <strong>✈ SkyDesk</strong> pill with aircraft count; click to restore, or use <strong>—</strong> on the header.</li>
              <li>Drag <strong>⋮⋮</strong> on the header to move the widget; drag <strong>⋮⋮ SkyDesk</strong> on the menu grip to reposition the dropdown (double-click grip to reset).</li>
            </ul>
          </section>
          <section class="sk-help-section">
            <h3>Radar</h3>
            <ul>
              <li><strong>Range</strong> 5–100 nm, <strong>refresh interval</strong> 1–15 s, <strong>rotation</strong> (N, NE, E…), and <strong>sweep animation</strong>.</li>
              <li><strong>Range rings</strong> and <strong>outer range ring</strong>; adjust rings &amp; compass opacity.</li>
              <li><strong>Blips</strong> — Aircraft icons or dots.</li>
              <li><strong>Aircraft Tags</strong> — Altitude, ground speed, aircraft type, tag size, tag background.</li>
              <li><strong>Traffic</strong> — Airliners, military, general aviation; <strong>hide traffic under 80 kt</strong>.</li>
              <li><strong>Emergency squawk alerts</strong> — Highlights 7500 · 7600 · 7700 when enabled.</li>
            </ul>
          </section>
          <section class="sk-help-section">
            <h3>Airport / ground</h3>
            <ul>
              <li>Available when watching an <strong>airport</strong> (not LAT/LONG).</li>
              <li>Click <strong>GND</strong> on the widget header or enable <strong>Airport ground mode</strong> under Advanced.</li>
              <li>Zooms to 1–6 nm (default 2.5 nm); shows <strong>runways</strong>, <strong>terminal footprints</strong>, and an airport info bar.</li>
              <li>Filters to surface traffic (≤150 kt). Toggle <strong>runways</strong> and <strong>airport marker</strong> under Radar.</li>
            </ul>
          </section>
          <section class="sk-help-section">
            <h3>Reference point</h3>
            <ul>
              <li>When watching LAT/LONG, enable <strong>Reference point</strong> under Radar to mark your watch center.</li>
              <li>Adjust <strong>reference point color</strong> and <strong>opacity</strong>.</li>
            </ul>
          </section>
          <section class="sk-help-section">
            <h3>Layers</h3>
            <ul>
              <li><strong>Weather radar</strong> (RainViewer) — latest precipitation; adjust weather opacity.</li>
              <li><strong>Terrain</strong> — hill shading under the radar.</li>
              <li><strong>Water</strong> — oceans and lakes fill.</li>
              <li>Each layer has its own opacity slider under Map Layers.</li>
            </ul>
          </section>
          <section class="sk-help-section">
            <h3>Aircraft interaction</h3>
            <ul>
              <li><strong>Shift+click</strong> an aircraft blip for a flight info card (callsign, type, altitude, speed, distance). Route path on radar requires subscription.</li>
              <li><strong>Shift+click</strong> the same aircraft again or press <strong>Escape</strong> to clear. Works on the full background radar canvas.</li>
              <li>Your selected aircraft and route card persist across page navigations for about 10 minutes (same watch center).</li>
            </ul>
          </section>
          <section class="sk-help-section">
            <h3>Flight tracking</h3>
            <ul>
              <li>Full-screen translucent world map: planned route, live position, and recorded trail.</li>
              <li><strong>Tracker opacity</strong> slider under the Track section (default 75%).</li>
              <li>Trail records positions over time and saves locally. Tracking persists across pages until you click <strong>Stop</strong>.</li>
              <li>Use <strong>Open full radar tab</strong> at the bottom of the menu for a larger view.</li>
            </ul>
          </section>
          <section class="sk-help-section">
            <h3>Subscription</h3>
            <ul>
              <li><strong>Free forever</strong> — Watch any airport in the corner widget: live blips, tags, refresh, shift+click info card, runways, and airport marker.</li>
              <li><strong>7-day free trial</strong> — Unlocks location watch, full background mode, flight tracking, map layers, ground mode, and route path on radar.</li>
              <li>After the trial, subscribe ($2.99/mo or $24.99/yr) to keep location watch, background display, flight tracking, and advanced layers.</li>
            </ul>
          </section>
          <section class="sk-help-section">
            <h3>Data sources</h3>
            <p class="sk-help-attribution">Terrain © Esri · Weather © RainViewer · Data ADS-B community</p>
          </section>
          <section class="sk-help-section">
            <h3>Tips</h3>
            <ul>
              <li>Radar traffic and your tracker view restore from a local cache when you open a new page — you may briefly see <strong>Updating…</strong> while fresh data loads.</li>
              <li>After extension updates, go to <code>chrome://extensions</code>, click <strong>Reload</strong> on SkyDesk, then hard-refresh the page (<strong>Ctrl+Shift+R</strong>).</li>
              <li>ADS-B coverage varies by region and altitude — not every aircraft transmits. Try a busier airport or increase range.</li>
              <li>SkyDesk is for entertainment only — <strong>not for flight planning, navigation, or operational use</strong>. ADS-B data may be delayed or incomplete.</li>
            </ul>
          </section>
        </div>
      </div>
    </div>`;
  }

  function menuHtml() {
    return `<div class="sk-menu hidden">
      <div class="sk-menu-grip" title="Drag to move · double-click to reset">⋮⋮ SkyDesk</div>
      <div class="sk-menu-section">
        <div class="sk-menu-label">General</div>
        <label class="sk-menu-row"><input type="checkbox" data-cfg="overlay" /> Show radar on web pages</label>
      </div>
      <div class="sk-menu-section">
        <div class="sk-menu-label">Display</div>
        <label class="sk-menu-row"><input type="radio" name="sk-dm" data-cfg="displayMode" value="corner" /> Corner widget</label>
        <label class="sk-menu-row"><input type="radio" name="sk-dm" data-cfg="displayMode" value="background" data-tour="display-bg" /> Full background <span class="sk-menu-sub sk-bg-gate-hint hidden">Requires trial or subscription</span></label>
        <label class="sk-menu-row"><input type="radio" name="sk-dm" data-cfg="displayMode" value="minimized" /> Minimized</label>
      </div>
      <div class="sk-menu-section sk-menu-center">
        <div class="sk-menu-label">Mode</div>
        <label class="sk-menu-row"><input type="radio" name="sk-source" class="sk-source" value="airport" /> Watch an airport</label>
        <label class="sk-menu-row"><input type="radio" name="sk-source" class="sk-source" value="coords" data-tour="mode-coords" /> Watch a latitude / longitude <span class="sk-menu-sub sk-coords-gate-hint hidden">Subscribe to watch planes at your location</span></label>
        <label class="sk-menu-row"><input type="radio" name="sk-source" class="sk-source" value="track" data-tour="mode-track" /> Track a flight <span class="sk-menu-sub sk-track-gate-hint hidden">Requires trial or subscription</span></label>
        <div class="sk-center-airport">
          <div class="sk-menu-field">
            <input type="text" class="sk-apt-q" placeholder="Search ICAO, IATA or name…" autocomplete="off" spellcheck="false" />
            <ul class="sk-apt-suggest hidden"></ul>
          </div>
        </div>
        <div class="sk-center-coords hidden">
          <label class="sk-menu-row sk-menu-coord"><span>Latitude</span><input type="text" class="sk-coord-lat" placeholder="42.2138" autocomplete="off" /></label>
          <label class="sk-menu-row sk-menu-coord"><span>Longitude</span><input type="text" class="sk-coord-lon" placeholder="-83.3538" autocomplete="off" /></label>
          <label class="sk-menu-row sk-menu-coord"><span>Label</span><input type="text" class="sk-coord-label" placeholder="Home" autocomplete="off" /></label>
          <button type="button" class="sk-coord-apply">Update</button>
          <button type="button" class="sk-geo-btn" data-tour="geo-btn">Use my location</button>
        </div>
        <div class="sk-source-track hidden">
          <label class="sk-menu-row"><input type="radio" name="sk-track-kind" class="sk-track-kind" value="flight" checked /> Flight number</label>
          <label class="sk-menu-row"><input type="radio" name="sk-track-kind" class="sk-track-kind" value="tail" /> Tail number</label>
          <div class="sk-track-flight-field sk-menu-field sk-track-field">
            <input type="text" class="sk-track-input" placeholder="Flight number (e.g. DAL123)" autocomplete="off" spellcheck="false" />
          </div>
          <div class="sk-track-tail-field sk-menu-field sk-track-field hidden">
            <input type="text" class="sk-track-tail-input sk-track-input" placeholder="Tail number (e.g. N12345, G-ABCD)" autocomplete="off" spellcheck="false" />
          </div>
          <div class="sk-track-actions">
            <button type="button" class="sk-track-btn">Track</button>
            <button type="button" class="sk-track-stop hidden">Stop</button>
          </div>
          <div class="sk-track-status"></div>
          <label class="sk-menu-row sk-menu-slider">
            <span>Tracker opacity <em class="sk-tracker-op-val">75%</em></span>
            <input type="range" data-cfg="trackerOpacity" min="20" max="100" step="5" />
          </label>
          <div class="sk-menu-sub">Full-screen translucent map: route, live position and recorded trail over outlined countries / states — on every page.</div>
        </div>
      </div>
      <div class="sk-menu-section">
        <div class="sk-menu-label">Traffic</div>
        <label class="sk-menu-row"><input type="checkbox" data-cfg="hideUnder80Kts" /> Hide traffic under 80 kt</label>
        <label class="sk-menu-row"><input type="checkbox" data-cfg="showAirlines" /> Airliners</label>
        <label class="sk-menu-row"><input type="checkbox" data-cfg="showMilitary" /> Military</label>
        <label class="sk-menu-row"><input type="checkbox" data-cfg="showGa" /> General aviation</label>
        <label class="sk-menu-row"><input type="checkbox" data-cfg="showEmergency" /> Emergency squawk alerts <span class="sk-menu-sub">7500 · 7600 · 7700</span></label>
      </div>
      <div class="sk-menu-section">
        <div class="sk-menu-label">Aircraft Tags</div>
        <label class="sk-menu-row"><input type="checkbox" data-cfg="showAltitude" /> Altitude</label>
        <label class="sk-menu-row"><input type="checkbox" data-cfg="showSpeed" /> Ground speed</label>
        <label class="sk-menu-row"><input type="checkbox" data-cfg="showType" /> Aircraft type</label>
        <label class="sk-menu-row sk-menu-slider">
          <span>Tag text size <em class="sk-tag-font-val">9px</em></span>
          <input type="range" data-cfg="tagFontSize" min="7" max="14" step="1" />
        </label>
        <label class="sk-menu-row"><input type="checkbox" data-cfg="showTagBg" /> Tag background</label>
      </div>
      <div class="sk-menu-section">
        <div class="sk-menu-label">Radar</div>
        <label class="sk-menu-row"><input type="checkbox" data-cfg="showRangeRings" /> Range rings</label>
        <label class="sk-menu-row"><input type="checkbox" data-cfg="showOuterRing" /> Outer range ring</label>
        <label class="sk-menu-row"><input type="checkbox" data-cfg="showRunways" /> Runways</label>
        <label class="sk-menu-row"><input type="checkbox" data-cfg="showAirportDot" /> Airport marker <span class="sk-menu-sub">center dot</span></label>
        <div class="sk-home-marker-cfg">
          <label class="sk-menu-row"><input type="checkbox" data-cfg="showHomeMarker" /> Reference point <span class="sk-menu-sub sk-home-marker-sub">watch center</span></label>
          <label class="sk-menu-row"><input type="checkbox" data-cfg="showOverheadHighlight" /> Highlight overhead traffic <span class="sk-menu-sub">closest within 3 nm</span></label>
          <label class="sk-menu-row sk-menu-color"><span>Reference point color</span><input type="color" data-cfg="homeMarkerColor" /></label>
          <label class="sk-menu-row sk-menu-slider">
            <span>Reference point opacity <em class="sk-home-marker-op-val">90%</em></span>
            <input type="range" data-cfg="homeMarkerOpacity" min="0" max="100" step="5" />
          </label>
        </div>
        <label class="sk-menu-row sk-menu-slider">
          <span>Rings &amp; compass opacity <em class="sk-ring-opacity-val">100%</em></span>
          <input type="range" data-cfg="ringOpacity" min="0" max="100" step="5" />
        </label>
        <label class="sk-menu-row"><input type="checkbox" data-cfg="showSweep" /> Sweep animation</label>
        <label class="sk-menu-row sk-menu-slider">
          <span>Range <em class="sk-range-val">40 nm</em></span>
          <input type="range" data-cfg="rangeNm" min="5" max="100" step="5" />
        </label>
        <label class="sk-menu-row sk-menu-slider" data-tour="radar-opacity">
          <span>Radar opacity <em class="sk-opacity-val">55%</em></span>
          <input type="range" data-cfg="opacity" min="20" max="100" step="5" />
        </label>
        <label class="sk-menu-row sk-menu-slider">
          <span>Rotation <em class="sk-heading-val">N</em></span>
          <input type="range" data-cfg="heading" min="0" max="359" step="15" />
        </label>
        <label class="sk-menu-row sk-menu-slider">
          <span>Refresh interval <em class="sk-refresh-val">2s</em></span>
          <span class="sk-feed-status sk-menu-sub"></span>
          <input type="range" data-cfg="refreshSec" min="1" max="15" step="1" />
        </label>
      </div>
      <div class="sk-menu-section" data-tour="layers-section">
        <div class="sk-menu-label">Map Layers</div>
        <label class="sk-menu-row"><input type="checkbox" data-cfg="showWeather" /> Weather radar <span class="sk-menu-sub">RainViewer</span></label>
        <label class="sk-menu-row sk-menu-slider">
          <span>Weather opacity <em class="sk-weather-op-val">70%</em></span>
          <input type="range" data-cfg="weatherOpacity" min="0" max="100" step="5" />
        </label>
        <label class="sk-menu-row"><input type="checkbox" data-cfg="showTerrain" /> Terrain</label>
        <label class="sk-menu-row sk-menu-slider">
          <span>Terrain opacity <em class="sk-terrain-op-val">60%</em></span>
          <input type="range" data-cfg="terrainOpacity" min="0" max="100" step="5" />
        </label>
        <label class="sk-menu-row"><input type="checkbox" data-cfg="showWater" /> Water <span class="sk-menu-sub">oceans &amp; lakes</span></label>
        <label class="sk-menu-row sk-menu-slider">
          <span>Water opacity <em class="sk-water-op-val">70%</em></span>
          <input type="range" data-cfg="waterOpacity" min="0" max="100" step="5" />
        </label>
        <p class="sk-attribution">Terrain © Esri · Weather © RainViewer · Data ADS-B community</p>
      </div>
      <div class="sk-menu-section">
        <div class="sk-menu-label">Colors</div>
        <label class="sk-menu-row sk-menu-color"><span>Aircraft</span><input type="color" data-cfg="colorPlane" /></label>
        <label class="sk-menu-row sk-menu-color"><span>Military</span><input type="color" data-cfg="colorMilitary" /></label>
        <label class="sk-menu-row sk-menu-color"><span>Aircraft tag</span><input type="color" data-cfg="colorTag" /></label>
        <label class="sk-menu-row sk-menu-color"><span>Tag background</span><input type="color" data-cfg="colorTagBg" /></label>
        <label class="sk-menu-row sk-menu-color"><span>Airport</span><input type="color" data-cfg="colorAirport" /></label>
        <label class="sk-menu-row sk-menu-color"><span>Rings &amp; compass</span><input type="color" data-cfg="colorRings" /></label>
        <label class="sk-menu-row sk-menu-color"><span>Runways</span><input type="color" data-cfg="colorRunway" /></label>
        <label class="sk-menu-row sk-menu-color"><span>Menu</span><input type="color" data-cfg="colorMenu" /></label>
      </div>
      <div class="sk-menu-section">
        <div class="sk-menu-label">Advanced</div>
        <label class="sk-menu-row" data-tour="flight-path"><input type="checkbox" data-cfg="proFlightTrack" /> Flight path tracking <span class="sk-menu-sub">Shift-click an aircraft</span></label>
        <label class="sk-menu-row sk-pro-ground"><input type="checkbox" data-cfg="proGroundMode" /> Airport ground mode <span class="sk-menu-sub">FAA + OSM · ≤ 150 kt</span></label>
        <label class="sk-menu-row sk-menu-slider">
          <span>Ground range <em class="sk-ground-range-val">2.5 nm</em></span>
          <input type="range" data-cfg="groundRangeNm" min="1" max="6" step="0.5" />
        </label>
      </div>
      <div class="sk-menu-section">
        <div class="sk-menu-label">Blips</div>
        <label class="sk-menu-row"><input type="radio" name="sk-blip" data-cfg="blipStyle" value="plane" /> Aircraft icons</label>
        <label class="sk-menu-row"><input type="radio" name="sk-blip" data-cfg="blipStyle" value="dot" /> Dots</label>
      </div>
      <div class="sk-menu-section sk-subscription">
        <div class="sk-menu-label">Subscription</div>
        <p class="sk-sub-status">Checking subscription…</p>
        <button type="button" class="sk-menu-action sk-sub-trial" data-action="trial">Start 7-day trial (email only)</button>
        <button type="button" class="sk-menu-action" data-action="subscription">Subscribe · $2.99/mo or $24.99/yr</button>
      </div>
      <div class="sk-menu-section sk-menu-actions">
        <button type="button" class="sk-menu-action" data-action="open-window">Open full radar tab</button>
        <button type="button" class="sk-menu-action" data-action="share">Share SkyDesk link</button>
      </div>
      <div class="sk-menu-footer">
        <button type="button" class="sk-help-btn" title="How to use SkyDesk">? How to use SkyDesk</button>
        <p class="sk-legal-links">
          <button type="button" class="sk-legal-link" data-legal="privacy">Privacy</button>
          · <button type="button" class="sk-legal-link" data-legal="terms">Terms</button>
          · Not for navigation
        </p>
      </div>
      <p class="sk-disclaimer">For entertainment only — not for flight planning, navigation, or operational use. ADS-B data may be delayed or incomplete.</p>
    </div>`;
  }

  function bindMenuControls() {
    const menu = getMenu();
    if (!menu || menu.dataset.bound) return;
    menu.dataset.bound = "1";

    menu.querySelectorAll("[data-cfg]").forEach((el) => {
      const key = el.dataset.cfg;
      const handler = () => {
        const keepScroll = menu.scrollTop;
        let val;
        if (el.type === "checkbox") val = el.checked;
        else if (el.type === "radio") {
          if (!el.checked) return;
          val = ["rangeNm", "opacity", "tagFontSize", "heading", "refreshSec", "ringOpacity", "homeMarkerOpacity", "weatherOpacity", "terrainOpacity", "waterOpacity", "trackerOpacity", "groundRangeNm"].includes(key) ? Number(el.value) : el.value;
        } else val = ["rangeNm", "opacity", "tagFontSize", "heading", "refreshSec", "ringOpacity", "homeMarkerOpacity", "weatherOpacity", "terrainOpacity", "waterOpacity", "trackerOpacity", "groundRangeNm"].includes(key) ? Number(el.value) : el.value;

        const finish = () => {
          let patch = key === "overlay" ? overlayEnablePatch(val) : { [key]: val };
          if (key === "centerMode") {
            if (val === "coords") {
              patch.icao = "";
              patch.proGroundMode = false;
              runways = [];
              runwayReq++;
              terminals = [];
              terminalReq++;
              airportInfo = null;
              airportInfoReq++;
              syncCenterPanels(menu);
              const lat = SKCenter.parseCoord(menu.querySelector(".sk-coord-lat")?.value);
              const lon = SKCenter.parseCoord(menu.querySelector(".sk-coord-lon")?.value);
              if (SKCenter.validateLat(lat) && SKCenter.validateLon(lon)) {
                patch.centerLat = lat;
                patch.centerLon = lon;
                patch.centerLabel =
                  menu.querySelector(".sk-coord-label")?.value.trim() ||
                  SKCenter.formatCoords(lat, lon);
              }
            } else {
              syncCenterPanels(menu);
            }
          } else if (key === "rangeNm") {
            const rngVal = menu.querySelector(".sk-range-val");
            if (rngVal) rngVal.textContent = `${val} nm`;
          } else if (key === "opacity") {
            const opVal = menu.querySelector(".sk-opacity-val");
            if (opVal) opVal.textContent = `${val}%`;
          } else if (key === "ringOpacity") {
            const rv = menu.querySelector(".sk-ring-opacity-val");
            if (rv) rv.textContent = `${val}%`;
          } else if (key === "homeMarkerOpacity") {
            const hv = menu.querySelector(".sk-home-marker-op-val");
            if (hv) hv.textContent = `${val}%`;
          } else if (key === "weatherOpacity") {
            const wv = menu.querySelector(".sk-weather-op-val");
            if (wv) wv.textContent = `${val}%`;
          } else if (key === "terrainOpacity") {
            const tv = menu.querySelector(".sk-terrain-op-val");
            if (tv) tv.textContent = `${val}%`;
          } else if (key === "waterOpacity") {
            const wv = menu.querySelector(".sk-water-op-val");
            if (wv) wv.textContent = `${val}%`;
          } else if (key === "trackerOpacity") {
            const tv = menu.querySelector(".sk-tracker-op-val");
            if (tv) tv.textContent = `${val}%`;
            if (trackMode) {
              // Live preview: feed the new value to the backdrop alpha and
              // repaint. saveCfg(patch) below persists the same value.
              cfg.trackerOpacity = val;
              if (root) root.style.opacity = "";
              drawTrackCanvas();
            }
          } else if (key === "tagFontSize") {
            const tv = menu.querySelector(".sk-tag-font-val");
            if (tv) tv.textContent = `${val}px`;
          } else if (key === "heading") {
            const hv = menu.querySelector(".sk-heading-val");
            if (hv) hv.textContent = headingLabel(val);
          } else if (key === "refreshSec") {
            const rv = menu.querySelector(".sk-refresh-val");
            if (rv) rv.textContent = `${val}s`;
          } else if (key === "groundRangeNm") {
            const gv = menu.querySelector(".sk-ground-range-val");
            if (gv) gv.textContent = `${val} nm`;
          } else if (key === "overlay" && !val) {
            closeMenu();
          } else if (key === "proFlightTrack" && !val) {
            clearFlightSelection();
          } else if (key === "proGroundMode") {
            if (val && !canUseGroundMode()) patch.proGroundMode = false;
          } else if (key === "displayMode") {
            if (val === "background" && trackMode) {
              const corner = menu.querySelector('[data-cfg="displayMode"][value="corner"]');
              if (corner) corner.checked = true;
              showMenuStatus("Flight tracking stays in the corner widget so the route and menu stay together.");
              return;
            }
            if (val === "background" && !canUseBackgroundMode()) {
              const corner = menu.querySelector('[data-cfg="displayMode"][value="corner"]');
              if (corner) corner.checked = true;
              closeMenu();
              return;
            }
            closeMenu();
          }
          saveCfg(patch);
          if (menu.scrollTop !== keepScroll) menu.scrollTop = keepScroll;
        };

        const needsEntitlement =
          window.SKEntitlement?.cfgValueRequiresEntitlement(key, val) &&
          (el.type === "checkbox" || el.type === "radio");
        if (needsEntitlement && !isEntitled()) {
          requireEntitlement().then((ok) => {
            if (!ok) {
              if (el.type === "checkbox") el.checked = false;
              else if (el.type === "radio") syncMenuFromCfg();
              if (key === "displayMode" && val === "background") showGateFeedback("background");
              else if (key === "centerMode" && val === "coords") showGateFeedback("coords");
              else showGateFeedback();
              return;
            }
            finish();
          }).catch(handleContextError);
          return;
        }
        finish();
      };

      el.addEventListener("change", (e) => {
        e.stopPropagation();
        handler();
      });
      if (el.type === "range") {
        el.addEventListener("input", (e) => {
          e.stopPropagation();
          handler();
        });
      }
      if (el.type === "color") {
        el.addEventListener("input", (e) => {
          e.stopPropagation();
          handler();
        });
      }
    });

    menu.querySelectorAll(".sk-source").forEach((r) => {
      r.addEventListener("change", (e) => {
        e.stopPropagation();
        if (!r.checked) return;
        // Selecting a mode shows/hides its sub-panel (a height change). Preserve
        // the scroll so the dropdown doesn't snap to the top.
        const keepScroll = menu.scrollTop;
        setSource(r.value);
        if (menu.scrollTop !== keepScroll) menu.scrollTop = keepScroll;
      });
    });

    const aptQ = menu.querySelector(".sk-apt-q");
    const aptUl = menu.querySelector(".sk-apt-suggest");
    let aptTimer = null;

    aptQ?.addEventListener("input", (e) => {
      e.stopPropagation();
      clearTimeout(aptTimer);
      const q = e.target.value.trim();
      if (!q) {
        aptSearchSeq++;
        aptUl?.classList.add("hidden");
        return;
      }
      // Active typing is explicit intent to search — lift any post-pick suppress.
      aptPickedAt = 0;
      aptTimer = setTimeout(() => runAptSearch(q), 180);
    });

    aptQ?.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        pickAirportFromMenu(e.target.value);
      }
      if (e.key === "Escape") {
        aptSearchSeq++;
        aptUl?.classList.add("hidden");
      }
    });

    aptQ?.addEventListener("focus", (e) => {
      e.stopPropagation();
      if (aptSuppressed()) return;
      const q = e.target.value.trim();
      if (q) runAptSearch(q);
    });

    menu.querySelectorAll(".sk-coord-lat, .sk-coord-lon, .sk-coord-label").forEach((el) => {
      el.addEventListener("change", (e) => {
        e.stopPropagation();
        saveCoordsFromMenu();
      });
      el.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          saveCoordsFromMenu();
        }
      });
    });

    menu.querySelector(".sk-coord-apply")?.addEventListener("click", (e) => {
      e.stopPropagation();
      saveCoordsFromMenu();
    });

    menu.querySelector(".sk-geo-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      useMyLocation();
    });

    // Content scripts can't use chrome.tabs — ask the background worker to open
    // the page in a new tab.
    const openPage = (path) => {
      safeSendMessage({ type: "open-page", path });
    };

    menu.querySelector('[data-action="open-window"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      openPage("src/window/window.html");
    });

    menu.querySelector('[data-action="trial"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      markTrialTourPending();
      safeSendMessage({ type: "open-trial" });
    });

    menu.querySelector('[data-action="subscription"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      safeSendMessage({ type: "open-subscription" });
    });

    menu.querySelector('[data-action="share"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      const url = "https://chromewebstore.google.com/detail/skydesk/bebpoadgmffalooplgaloncgblhblbkc";
      const done = () => showMenuStatus("Chrome Web Store link copied — share so friends can install SkyDesk.", 5000);
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(url).then(done).catch(() => showMenuStatus(url, 8000));
      } else {
        showMenuStatus(url, 8000);
      }
    });

    menu.querySelectorAll(".sk-legal-link").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const page = btn.dataset.legal === "terms" ? "terms.html" : "privacy.html";
        openPage(`src/privacy/${page}`);
      });
    });

    const trackInput = menu.querySelector(".sk-track-input");
    const trackTailInput = menu.querySelector(".sk-track-tail-input");
    const trackBtn = menu.querySelector(".sk-track-btn");
    const trackStop = menu.querySelector(".sk-track-stop");

    menu.querySelectorAll(".sk-track-kind").forEach((r) => {
      r.addEventListener("change", () => {
        if (!r.checked) return;
        saveCfg({ trackKind: r.value });
        syncTrackUI();
      });
    });

    const doTrack = async () => {
      if (!(await requireEntitlement())) return;
      const kind = menu.querySelector('.sk-track-kind:checked')?.value || "flight";
      if (kind === "tail") startTrackTail(trackTailInput?.value);
      else startTrack(trackInput?.value);
    };

    trackBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      doTrack();
    });
    trackInput?.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        doTrack();
      }
    });
    trackTailInput?.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        doTrack();
      }
    });
    trackStop?.addEventListener("click", (e) => {
      e.stopPropagation();
      clearTrack();
    });

    menu.querySelector(".sk-center-airport .sk-menu-field")?.addEventListener("click", (e) => {
      if (e.target.closest(".sk-apt-suggest")) return;
      e.stopPropagation();
      // Don't grab focus on the trailing click right after a pick — that would
      // re-open the suggestions we just dismissed.
      if (aptSuppressed()) return;
      menu.querySelector(".sk-apt-q")?.focus();
    });

    bindAptSuggest(menu);

    menu.addEventListener("click", (e) => e.stopPropagation());
  }

  function bindHelp() {
    if (!root || root.dataset.helpBound) return;
    root.dataset.helpBound = "1";

    const modal = root.querySelector(".sk-help-modal");
    if (!modal) return;

    const open = () => {
      modal.classList.remove("hidden");
      root.classList.add("sk-help-open");
      modal.querySelector(".sk-help-close")?.focus();
    };

    const close = () => {
      modal.classList.add("hidden");
      root.classList.remove("sk-help-open");
    };

    root.querySelector(".sk-help-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      open();
    });

    modal.querySelector(".sk-help-close")?.addEventListener("click", (e) => {
      e.stopPropagation();
      close();
    });

    modal.querySelector(".sk-help-backdrop")?.addEventListener("click", (e) => {
      e.stopPropagation();
      close();
    });

    modal.querySelector(".sk-help-panel")?.addEventListener("click", (e) => e.stopPropagation());

    // Attach the global Escape handler once for the page lifetime. It re-queries
    // the current root's modal so it keeps working across remounts without
    // stacking duplicate listeners.
    if (!helpWindowBound) {
      helpWindowBound = true;
      window.addEventListener("keydown", (e) => {
        const m = root?.querySelector(".sk-help-modal");
        if (e.key === "Escape" && m && !m.classList.contains("hidden")) {
          e.stopPropagation();
          m.classList.add("hidden");
          root?.classList.remove("sk-help-open");
        }
        const t = root?.querySelector(".sk-tour");
        if (e.key === "Escape" && t && !t.classList.contains("hidden")) {
          e.stopPropagation();
          endTrialTour();
        }
      });
    }
  }

  function tourModalHtml() {
    return `<div class="sk-tour hidden" role="dialog" aria-modal="true" aria-labelledby="sk-tour-title">
      <div class="sk-tour-backdrop"></div>
      <div class="sk-tour-spotlight hidden" aria-hidden="true"></div>
      <div class="sk-tour-card">
        <div class="sk-tour-progress"></div>
        <h2 id="sk-tour-title" class="sk-tour-title"></h2>
        <p class="sk-tour-body"></p>
        <div class="sk-tour-actions">
          <button type="button" class="sk-tour-skip">Skip tour</button>
          <button type="button" class="sk-tour-next">Next</button>
        </div>
      </div>
    </div>`;
  }

  function markTrialTourPending() {
    if (!isExtensionContextValid()) return;
    try {
      chrome.storage?.local?.set({ [TRIAL_TOUR_PENDING_KEY]: true });
    } catch (e) {
      if (!isContextInvalidatedError(e)) console.warn("[SkyDesk] markTrialTourPending:", e);
    }
  }

  function isFreshTrialState(state) {
    if (!state?.trialActive || state.paid || !state.trialStartedAt) return false;
    const t = new Date(state.trialStartedAt).getTime();
    return Number.isFinite(t) && Date.now() - t < 10 * 60 * 1000;
  }

  function openMenuForTour() {
    const menu = getMenu();
    if (menu && menu.classList.contains("hidden")) toggleMenu();
  }

  function clearTourMenuPreview() {
    const menu = getMenu();
    menu?.classList.remove("sk-tour-preview-coords", "sk-tour-preview-track");
  }

  function welcomeModalHtml() {
    return `<div class="sk-welcome sk-tour hidden" role="dialog" aria-modal="true" aria-labelledby="sk-welcome-title">
      <div class="sk-tour-backdrop"></div>
      <div class="sk-tour-spotlight hidden" aria-hidden="true"></div>
      <div class="sk-tour-card">
        <div class="sk-welcome-progress sk-tour-progress"></div>
        <h2 id="sk-welcome-title" class="sk-tour-title"></h2>
        <p class="sk-welcome-body sk-tour-body"></p>
        <p class="sk-welcome-note hidden">Email only — no credit card required.</p>
        <div class="sk-tour-actions sk-welcome-actions">
          <button type="button" class="sk-welcome-skip sk-tour-skip">Skip setup</button>
          <button type="button" class="sk-welcome-next sk-tour-next">Next</button>
          <button type="button" class="sk-welcome-trial sk-welcome-cta hidden">Start 7-day free trial</button>
          <button type="button" class="sk-welcome-free sk-tour-skip hidden">Continue with free corner radar</button>
        </div>
      </div>
    </div>`;
  }

  function welcomeSteps() {
    return [
      {
        title: "Welcome to SkyDesk",
        body:
          "Live flight radar while you browse. The <strong>corner widget</strong> is free forever — pick an airport and watch live planes, runways, and tags.",
        target: () => root?.querySelector(".sk-panel"),
      },
      {
        title: "Move it & open settings",
        body:
          "Drag <strong>⋮⋮</strong> to reposition the radar. Click <strong>SkyDesk ▾</strong> for modes, range, filters, and the full guide.",
        target: () => getTrigger(),
      },
      {
        title: "Try full-background radar",
        body:
          "Pro puts a semi-transparent radar over your <strong>entire page</strong> — great for watching traffic while you work. Also unlocks location watch and flight tracking.",
        target: null,
        trialStep: true,
      },
    ];
  }

  function endWelcome(markDone = true) {
    welcomeActive = false;
    welcomeStepIndex = -1;
    unbindTourReposition();
    clearTourMenuPreview();
    const welcome = root?.querySelector(".sk-welcome");
    welcome?.classList.add("hidden");
    root?.classList.remove("sk-tour-open");
    if (markDone) {
      try {
        chrome.storage?.local?.set({ [WELCOME_DONE_KEY]: true });
      } catch (_) {}
    }
  }

  function renderWelcomeStep(index) {
    const welcome = root?.querySelector(".sk-welcome");
    if (!welcome) return;
    const steps = welcomeSteps();
    if (index < 0 || index >= steps.length) {
      endWelcome(true);
      return;
    }
    welcomeStepIndex = index;
    const step = steps[index];
    setHTML(welcome.querySelector(".sk-tour-title"), step.title);
    setHTML(welcome.querySelector(".sk-welcome-body"), step.body);
    welcome.querySelector(".sk-welcome-progress").textContent =
      `Step ${index + 1} of ${steps.length}`;

    const nextBtn = welcome.querySelector(".sk-welcome-next");
    const trialBtn = welcome.querySelector(".sk-welcome-trial");
    const freeBtn = welcome.querySelector(".sk-welcome-free");
    const note = welcome.querySelector(".sk-welcome-note");
    const isTrialStep = !!step.trialStep;
    nextBtn?.classList.toggle("hidden", isTrialStep);
    trialBtn?.classList.toggle("hidden", !isTrialStep);
    freeBtn?.classList.toggle("hidden", !isTrialStep);
    note?.classList.toggle("hidden", !isTrialStep);

    const spotlight = welcome.querySelector(".sk-tour-spotlight");
    const card = welcome.querySelector(".sk-tour-card");
    const target = typeof step.target === "function" ? step.target() : null;
    if (!target) {
      spotlight?.classList.add("hidden");
      card?.classList.add("sk-tour-card-center");
      card?.style.removeProperty("left");
      card?.style.removeProperty("top");
      return;
    }
    card?.classList.remove("sk-tour-card-center");
    const rect = target.getBoundingClientRect();
    spotlight?.classList.remove("hidden");
    spotlight.style.left = `${Math.max(0, rect.left - 4)}px`;
    spotlight.style.top = `${Math.max(0, rect.top - 4)}px`;
    spotlight.style.width = `${rect.width + 8}px`;
    spotlight.style.height = `${rect.height + 8}px`;
    const cardRect = card.getBoundingClientRect();
    let left = rect.right + 12;
    let top = rect.top;
    if (left + cardRect.width > window.innerWidth - 12) left = rect.left - cardRect.width - 12;
    if (top + cardRect.height > window.innerHeight - 12) top = window.innerHeight - cardRect.height - 12;
    card.style.left = `${Math.max(12, left)}px`;
    card.style.top = `${Math.max(12, top)}px`;
  }

  function startWelcome() {
    if (welcomeActive || tourActive || !root || !cfg.enabled || !cfg.overlay) return;
    if (isEntitled()) return;
    if (!root.querySelector(".sk-welcome")) {
      insertHTML(root, "beforeend", welcomeModalHtml());
      bindWelcome();
    }
    const welcome = root.querySelector(".sk-welcome");
    if (!welcome) return;
    welcomeActive = true;
    welcomeStepIndex = 0;
    bindTourReposition();
    welcome.classList.remove("hidden");
    root.classList.add("sk-tour-open");
    renderWelcomeStep(0);
    welcome.querySelector(".sk-welcome-next")?.focus();
  }

  function maybeOfferWelcome() {
    if (welcomeActive || tourActive || !overlayActive()) return;
    if (isEntitled()) return;
    chrome.storage?.local?.get([WELCOME_DONE_KEY], (s) => {
      if (s?.[WELCOME_DONE_KEY]) return;
      setTimeout(() => startWelcome(), 900);
    });
  }

  function enableBackgroundAfterTrial() {
    if (!isEntitled() || cfg.displayMode === "background") return;
    saveCfg({ displayMode: "background" });
    syncMenuFromCfg();
    paint();
  }

  function bindWelcome() {
    const welcome = root?.querySelector(".sk-welcome");
    if (!welcome || welcome.dataset.bound) return;
    welcome.dataset.bound = "1";

    welcome.querySelector(".sk-welcome-skip")?.addEventListener("click", (e) => {
      e.stopPropagation();
      endWelcome(true);
    });

    welcome.querySelector(".sk-welcome-free")?.addEventListener("click", (e) => {
      e.stopPropagation();
      endWelcome(true);
    });

    welcome.querySelector(".sk-welcome-next")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const steps = welcomeSteps();
      if (welcomeStepIndex >= steps.length - 1) {
        endWelcome(true);
        return;
      }
      renderWelcomeStep(welcomeStepIndex + 1);
    });

    welcome.querySelector(".sk-welcome-trial")?.addEventListener("click", (e) => {
      e.stopPropagation();
      markTrialTourPending();
      safeSendMessage({ type: "open-trial" }).then((res) => {
        if (!res?.ok) {
          showMenuStatus("Could not open trial signup — try again from the SkyDesk menu.", 6000);
          return;
        }
        setHTML(
          welcome.querySelector(".sk-welcome-body"),
          "A signup page opened in a new tab. Enter your <strong>email only</strong> — no credit card. Full-background radar turns on automatically when your trial starts."
        );
        welcome.querySelector(".sk-welcome-trial")?.classList.add("hidden");
        welcome.querySelector(".sk-welcome-note")?.classList.remove("hidden");
      });
    });

    welcome.querySelector(".sk-tour-backdrop")?.addEventListener("click", (e) => e.stopPropagation());
    welcome.querySelector(".sk-tour-card")?.addEventListener("click", (e) => e.stopPropagation());
  }

  function tourSteps() {
    return [
      {
        title: "Your trial is active",
        body:
          "Welcome to SkyDesk Pro for 7 days — location watch, full-background radar, flight tracking, map layers, and more. This quick tour highlights where to find each feature in the menu.",
        target: null,
      },
      {
        title: "Open the SkyDesk menu",
        body:
          "Click <strong>SkyDesk ▾</strong> on the widget header (top-right in full-background mode) to open settings. You can also drag <strong>⋮⋮ SkyDesk</strong> on the menu grip to reposition the dropdown.",
        target: () => getTrigger(),
        prepare: () => {},
      },
      {
        title: "Watch planes overhead",
        body:
          "Under <strong>Mode</strong>, choose <strong>Watch a latitude / longitude</strong>, then tap <strong>Use my location</strong> to center the radar on traffic above you. Adjust <strong>Range</strong> under Radar to widen or tighten the view.",
        target: () => getMenu()?.querySelector("[data-tour='geo-btn']"),
        prepare: () => {
          openMenuForTour();
          const menu = getMenu();
          menu?.classList.add("sk-tour-preview-coords");
          menu?.classList.remove("sk-tour-preview-track");
        },
      },
      {
        title: "Track a flight",
        body:
          "Choose <strong>Track a flight</strong>, enter a <strong>flight number</strong> (e.g. DAL123) or <strong>tail number</strong> (e.g. N12345), then click <strong>Track</strong> for a world map with route, live position, and flown path.",
        target: () => getMenu()?.querySelector("[data-tour='mode-track']"),
        prepare: () => {
          openMenuForTour();
          const menu = getMenu();
          menu?.classList.add("sk-tour-preview-track");
          menu?.classList.remove("sk-tour-preview-coords");
        },
      },
      {
        title: "Full-background radar",
        body:
          "Under <strong>Display</strong>, switch to <strong>Full background</strong> for a semi-transparent radar over the entire page — great for watching traffic while you browse.",
        target: () => getMenu()?.querySelector("[data-tour='display-bg']"),
        prepare: () => {
          openMenuForTour();
          clearTourMenuPreview();
        },
      },
      {
        title: "Radar opacity",
        body:
          "Use <strong>Radar opacity</strong> to make the overlay more or less transparent. <strong>Rings &amp; compass opacity</strong> and <strong>Reference point opacity</strong> (when watching lat/long) are in the same Radar section.",
        target: () => getMenu()?.querySelector("[data-tour='radar-opacity']"),
        prepare: () => {
          openMenuForTour();
          clearTourMenuPreview();
        },
      },
      {
        title: "Map layer opacity",
        body:
          "Under <strong>Map Layers</strong>, enable weather, terrain, or water and tune each layer&apos;s opacity slider independently so the radar stays readable.",
        target: () => getMenu()?.querySelector("[data-tour='layers-section']"),
        prepare: () => {
          openMenuForTour();
          clearTourMenuPreview();
        },
      },
      {
        title: "Flight path &amp; more",
        body:
          "<strong>Shift+click</strong> an aircraft blip for a flight info card; enable <strong>Flight path tracking</strong> under Advanced to draw the route on radar. Open <strong>? How to use SkyDesk</strong> at the bottom of the menu anytime for the full guide.",
        target: () => getMenu()?.querySelector("[data-tour='flight-path']"),
        prepare: () => {
          openMenuForTour();
          clearTourMenuPreview();
        },
      },
      {
        title: "You&apos;re set",
        body:
          "Enjoy your trial — corner airport watch stays free forever after the 7 days. Subscribe from the menu when you&apos;re ready to keep Pro features.",
        target: null,
        prepare: () => clearTourMenuPreview(),
      },
    ];
  }

  function tourReposition() {
    if (welcomeActive) {
      renderWelcomeStep(welcomeStepIndex);
      return;
    }
    if (!tourActive) return;
    renderTourStep(tourStepIndex, false);
  }

  function bindTourReposition() {
    if (tourRepositionBound) return;
    tourRepositionBound = true;
    addEventListener("resize", tourReposition);
    addEventListener("scroll", tourReposition, true);
  }

  function unbindTourReposition() {
    if (!tourRepositionBound) return;
    tourRepositionBound = false;
    removeEventListener("resize", tourReposition);
    removeEventListener("scroll", tourReposition, true);
  }

  function endTrialTour() {
    tourActive = false;
    tourStepIndex = -1;
    unbindTourReposition();
    clearTourMenuPreview();
    const tour = root?.querySelector(".sk-tour");
    tour?.classList.add("hidden");
    root?.classList.remove("sk-tour-open");
    try {
      chrome.storage?.local?.set({
        [TRIAL_TOUR_DONE_KEY]: true,
        [TRIAL_TOUR_PENDING_KEY]: false,
      });
    } catch (_) {}
  }

  function renderTourStep(index, runPrepare = true) {
    const tour = root?.querySelector(".sk-tour");
    if (!tour) return;
    const steps = tourSteps();
    const step = steps[index];
    if (!step) return;

    if (runPrepare) step.prepare?.();

    setHTML(tour.querySelector(".sk-tour-title"), step.title);
    setHTML(tour.querySelector(".sk-tour-body"), step.body);
    tour.querySelector(".sk-tour-progress").textContent = `Step ${index + 1} of ${steps.length}`;

    const nextBtn = tour.querySelector(".sk-tour-next");
    if (nextBtn) nextBtn.textContent = index >= steps.length - 1 ? "Done" : "Next";

    const spotlight = tour.querySelector(".sk-tour-spotlight");
    const card = tour.querySelector(".sk-tour-card");
    const target = step.target?.();

    if (!spotlight || !card) return;

    if (!target || !target.isConnected) {
      spotlight.classList.add("hidden");
      card.classList.add("sk-tour-card-center");
      card.style.top = "";
      card.style.left = "";
      card.style.right = "";
      card.style.bottom = "";
      return;
    }

    spotlight.classList.remove("hidden");
    card.classList.remove("sk-tour-card-center");

    try {
      target.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch (_) {}

    const pad = 8;
    const rect = target.getBoundingClientRect();
    const x = Math.max(4, rect.left - pad);
    const y = Math.max(4, rect.top - pad);
    const w = Math.min(innerWidth - 8, rect.width + pad * 2);
    const h = Math.min(innerHeight - 8, rect.height + pad * 2);

    spotlight.style.left = `${x}px`;
    spotlight.style.top = `${y}px`;
    spotlight.style.width = `${w}px`;
    spotlight.style.height = `${h}px`;

    const cardRect = card.getBoundingClientRect();
    const margin = 12;
    let cardTop = rect.bottom + margin;
    if (cardTop + cardRect.height > innerHeight - margin) {
      cardTop = rect.top - cardRect.height - margin;
    }
    if (cardTop < margin) cardTop = margin;

    let cardLeft = rect.left;
    if (cardLeft + 320 > innerWidth - margin) cardLeft = innerWidth - 320 - margin;
    if (cardLeft < margin) cardLeft = margin;

    card.style.top = `${cardTop}px`;
    card.style.left = `${cardLeft}px`;
    card.style.right = "auto";
    card.style.bottom = "auto";
  }

  function startTrialTour() {
    if (tourActive || welcomeActive || !root || !cfg.enabled || !cfg.overlay) return;
    if (visualMode() === "minimized") return;
    ensureMounted();
    const tour = root.querySelector(".sk-tour");
    if (!tour) return;

    tourActive = true;
    tourStepIndex = 0;
    bindTourReposition();
    tour.classList.remove("hidden");
    root.classList.add("sk-tour-open");
    renderTourStep(0);
    tour.querySelector(".sk-tour-next")?.focus();
  }

  function maybeOfferTrialTour() {
    if (tourActive || !isEntitled() || entitlement.paid) return;
    if (!root || !cfg.enabled || !cfg.overlay) return;
    if (visualMode() === "minimized") return;

    chrome.storage?.local?.get([TRIAL_TOUR_DONE_KEY, TRIAL_TOUR_PENDING_KEY], (s) => {
      drainRuntimeLastError();
      if (s?.[TRIAL_TOUR_DONE_KEY]) return;
      const pending = s?.[TRIAL_TOUR_PENDING_KEY];
      const fresh = isFreshTrialState(entitlement);
      if (!pending && !fresh) return;
      setTimeout(() => startTrialTour(), 700);
    });
  }

  function bindTour() {
    if (!root || root.dataset.tourBound) return;
    root.dataset.tourBound = "1";
    const tour = root.querySelector(".sk-tour");
    if (!tour) return;

    tour.querySelector(".sk-tour-skip")?.addEventListener("click", (e) => {
      e.stopPropagation();
      endTrialTour();
    });

    tour.querySelector(".sk-tour-next")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const steps = tourSteps();
      if (tourStepIndex >= steps.length - 1) {
        endTrialTour();
        return;
      }
      tourStepIndex += 1;
      renderTourStep(tourStepIndex);
    });

    tour.querySelector(".sk-tour-backdrop")?.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    tour.querySelector(".sk-tour-card")?.addEventListener("click", (e) => e.stopPropagation());
  }

  function wireRootBindings() {
    if (!root) return;
    bindDrag();
    bindResize();
    bindChromeDrag();
    bindCanvasInput();
    bindFlightPick();
    const menu = getMenu();
    if (menu && !menu.dataset.bound) bindMenuControls();
    if (!root.dataset.helpBound) bindHelp();
    if (!root.dataset.tourBound) bindTour();
    if (root.querySelector(".sk-welcome")) bindWelcome();
  }

  function mount() {
    const existing = dedupeRoots();
    if (existing) {
      root = existing;
      if (!menuEl?.isConnected || (root && !root.contains(menuEl))) {
        menuEl = root.querySelector(".sk-menu");
      }
      if (!root.querySelector(".sk-tour")) {
        insertHTML(root, "beforeend", tourModalHtml());
      }
      if (!root.querySelector(".sk-welcome")) {
        insertHTML(root, "beforeend", welcomeModalHtml());
      }
      wireRootBindings();
      syncMenuFromCfg();
      return root;
    }

    // Drop stale floated menus/triggers if the widget was remounted (e.g.
    // MutationObserver). chromePos is preserved in cfg/storage and re-applied after mount.
    document.querySelectorAll("body > .sk-menu").forEach((el) => el.remove());
    document.querySelectorAll("body > .sk-head-trigger").forEach((el) => el.remove());
    menuEl = null;
    triggerEl = null;

    root = document.createElement("div");
    root.id = TAG;

    const panel = document.createElement("div");
    panel.className = "sk-panel";

    const headWrap = document.createElement("div");
    headWrap.className = "sk-head-wrap";

    const head = document.createElement("div");
    head.className = "sk-head";
    setHTML(head, `<button type="button" class="sk-drag" title="Drag to move">⋮⋮</button>
    <button type="button" class="sk-head-trigger" title="Settings" data-tour="menu-trigger">
      <span class="sk-title">SkyDesk</span>
      <span class="sk-chevron">▾</span>
    </button>
    <div class="sk-btns">
      <button type="button" class="sk-gnd-btn" title="Airport ground mode" hidden>GND</button>
      <button type="button" class="sk-btn sk-min" title="Minimize">—</button>
      <button type="button" class="sk-btn sk-close" title="Hide until refresh">×</button>
    </div>`);

    headWrap.append(head);
    insertHTML(headWrap, "beforeend", menuHtml());
    menuEl = headWrap.querySelector(".sk-menu");

    const canvas = document.createElement("canvas");

    const err = document.createElement("div");
    err.className = "sk-err";
    err.style.display = "none";

    const flightCard = document.createElement("div");
    flightCard.className = "sk-flight-card hidden";

    const resizeHandle = document.createElement("div");
    resizeHandle.className = "sk-resize";
    resizeHandle.title = "Drag to resize";

    panel.append(headWrap, canvas, err, flightCard, resizeHandle);
    root.appendChild(panel);

    const pill = document.createElement("button");
    pill.className = "sk-pill";
    pill.style.display = "none";
    pill.textContent = "✈ SkyDesk";
    root.appendChild(pill);

    insertHTML(root, "beforeend", helpModalHtml());
    insertHTML(root, "beforeend", tourModalHtml());
    insertHTML(root, "beforeend", welcomeModalHtml());

    const parent = document.body || document.documentElement;
    parent.appendChild(root);

    const headTrigger = head.querySelector(".sk-head-trigger");
    triggerEl = headTrigger;
    headTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      // A drag just ended on the trigger — don't also toggle the menu.
      if (headTrigger.dataset.suppressClick) return;
      toggleMenu();
    });

    head.querySelector(".sk-gnd-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleGroundMode();
    });

    head.querySelector(".sk-min").addEventListener("click", (e) => {
      e.stopPropagation();
      closeMenu();
      saveMode("minimized");
    });
    pill.addEventListener("click", () => {
      if (root.dataset.suppressPillClick) return;
      saveMode(lastNonMinMode || "corner");
    });
    head.querySelector(".sk-close").addEventListener("click", (e) => {
      e.stopPropagation();
      closeMenu();
      root.style.display = "none";
      clearTimeout(timer);
      cancelAnimationFrame(animId);
    });

    wireRootBindings();
    syncMenuFromCfg();

    if (!window.__SKYDESK_MENU_CLOSE) {
      window.__SKYDESK_MENU_CLOSE = true;
      document.addEventListener("click", (e) => {
        const wrap = root?.querySelector(".sk-head-wrap");
        const menu = getMenu();
        const trigger = getTrigger();
        // The floated menu/trigger are re-parented to #skydesk-root (outside the
        // head-wrap), so check them explicitly — their clicks are not "outside".
        if (
          !wrap ||
          wrap.contains(e.target) ||
          menu?.contains(e.target) ||
          trigger?.contains(e.target)
        )
          return;
        closeMenu();
      });
    }

    return root;
  }

  function resizeCanvas() {
    if (!root) return;
    const canvas = root.querySelector("canvas");
    if (!canvas) return;

    if (visualMode() === "background") {
      const dpr = devicePixelRatio || 1;
      const cw = Math.floor(innerWidth * dpr);
      const chh = Math.floor(innerHeight * dpr);
      if (canvas.width !== cw || canvas.height !== chh) {
        canvas.width = cw;
        canvas.height = chh;
      }
      canvas.style.width = `${innerWidth}px`;
      canvas.style.height = `${innerHeight}px`;
    } else {
      const s = cornerSize();
      if (canvas.width !== s || canvas.height !== s) {
        canvas.width = s;
        canvas.height = s;
      }
      canvas.style.setProperty("width", `${s}px`, "important");
      canvas.style.setProperty("height", `${s}px`, "important");
    }
  }

  function defaultCornerPosition() {
    const s = cornerSize();
    placeCorner(innerWidth - s - 20, innerHeight - s - 56, false);
    savePosition();
  }

  function placeCorner(x, y, persist = true) {
    const panel = root?.querySelector(".sk-panel");
    const pill = root?.querySelector(".sk-pill");
    if (!panel) return;

    const isMin = mode() === "minimized";
    const s = cornerSize();
    x = Math.max(8, Math.min(innerWidth - (isMin ? 120 : s) - 8, x));
    y = Math.max(8, Math.min(innerHeight - (isMin ? 40 : s + 36) - 8, y));
    pos.x = x;
    pos.y = y;

    // The stylesheet pins .sk-panel/.sk-pill with `left/top: auto !important`, so
    // inline styles must also be `!important` to win and actually move the box.
    if (isMin) {
      if (!pill) return;
      pill.style.setProperty("left", `${x}px`, "important");
      pill.style.setProperty("top", `${y}px`, "important");
    } else {
      panel.style.setProperty("left", `${x}px`, "important");
      panel.style.setProperty("top", `${y}px`, "important");
    }

    if (persist) savePosition();
  }

  function applyDisplayMode() {
    ensureMounted();
    if (!root) return;
    let m = visualMode();
    // Tracking uses the corner widget so the route canvas and dropdown stay one
    // unit. If a legacy session still has background+tracker, snap back to corner.
    if (trackMode && m === "background") {
      m = "corner";
      if (cfg.displayMode === "background") {
        cfg.displayMode = "corner";
        saveCfg({ displayMode: "corner" }, { immediate: true });
      }
    }
    if (mode() !== "minimized") lastNonMinMode = mode();
    root.classList.toggle("sk-ground-active", isGroundActive());
    root.classList.remove("sk-mode-corner", "sk-mode-background", "sk-mode-minimized");
    root.classList.add(`sk-mode-${m}`);

    const panel = root.querySelector(".sk-panel");
    const pill = root.querySelector(".sk-pill");
    if (!panel || !pill) return;

    // Only hoist to the front when not already there. Re-inserting a node that
    // is already in place still performs a DOM remove + insert, which resets any
    // scrolled descendant (the dropdown) back to the top AND blurs a focused menu
    // input. This ran on every ~2s refresh in background mode (the default for
    // airport/tracker), and was the root cause of the menu jumping to the top on
    // interaction and the airport-search caret vanishing.
    if (m === "background" && root.parentNode && root.parentNode.firstChild !== root) {
      root.parentNode.insertBefore(root, root.parentNode.firstChild);
    }

    if (m === "minimized") {
      panel.classList.add("sk-hidden");
      pill.style.display = "block";
      const chromeLoc = chromePos || lastChromeViewportPos;
      if (chromeLoc) {
        placeCorner(chromeLoc.x, chromeLoc.y, true);
        chromePos = null;
        lastChromeViewportPos = null;
        applyChromeFloat();
      } else if (pos.x == null) defaultCornerPosition();
      else placeCorner(pos.x, pos.y, false);
    } else {
      pill.style.display = "none";
      panel.classList.remove("sk-hidden");
      if (m === "corner") {
        if (pos.x == null) defaultCornerPosition();
        else placeCorner(pos.x, pos.y, false);
      }
    }

    resizeCanvas();
    updateMenuPlacement();
    applyChromeFloat();
  }

  // Collapse any accidental duplicate overlay roots down to a single instance.
  // This must run on every ensureMounted() rather than only inside mount(),
  // because when two roots are already attached document.getElementById() returns
  // one and mount() is never called — so the de-dupe would never fire from there.
  // Keeps the root we already track when it's still attached, else the first.
  function dedupeRoots() {
    const all = document.querySelectorAll(`#${TAG}`);
    if (all.length <= 1) return all[0] || null;
    const keep = root && root.isConnected && root.id === TAG ? root : all[0];
    all.forEach((el) => {
      if (el !== keep) el.remove();
    });
    return keep;
  }

  function ensureMounted() {
    dedupeRoots();
    if (!document.getElementById(TAG)) mount();
    if (!root) root = document.getElementById(TAG);
    ensureGroundBtn();
    applyTheme();
  }

  function ensureGroundBtn() {
    const head = root?.querySelector(".sk-head");
    if (!head || head.querySelector(".sk-gnd-btn")) return;
    const btns = head.querySelector(".sk-btns");
    if (!btns) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sk-gnd-btn";
    btn.textContent = "GND";
    btn.hidden = true;
    btn.title = "Airport ground mode";
    btns.insertBefore(btn, btns.firstChild);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleGroundMode();
    });
    syncGroundBtn();
  }

  function radarOpts() {
    const c = effectiveCfg();
    const ground = isGroundActive();
    const vm = visualMode();
    const bg = vm === "background";
    const range = fetchRangeNm();
    return {
      ...c,
      rangeNm: range,
      mode: bg ? "background" : "widget",
      fillBg: true,
      showLabels: true,
      maxBlips: ground ? 128 : bg ? 64 : 24,
      sweepAngle: ground ? null : c.showSweep ? sweepAngle : null,
      showSweep: ground ? false : c.showSweep,
      onLayerReady: paint,
    };
  }

  function updateHead(count, emgCount = 0) {
    const title = titleEl();
    if (!title) return;

    const menu = getMenu();
    if (menu && !menu.classList.contains("hidden")) syncMenuFromCfg();

    const lbl = center?.label || center?.icao || "SkyDesk";
    const showUpdating = showingCachedFeed && fetching;
    const showScanning = fetching && !initialFetchDone && !showUpdating;
    const gnd = isGroundActive() ? " · GND" : "";
    const rng = fetchRangeNm();
    const emg = emgCount > 0 ? ` · ⚠${emgCount}` : "";
    title.textContent = showUpdating
      ? `${lbl} · Updating…`
      : showScanning
        ? `${lbl} · Scanning…`
        : `${lbl}${gnd} · ${count}${emg} · ${rng}nm`;
    title.classList.toggle("sk-has-emerg", emgCount > 0);
    syncGroundBtn();
  }

  function paint() {
    if (!overlayActive()) {
      if (!isExtensionContextValid()) showExtensionReloadStatus();
      return;
    }
    try {
      ensureMounted();
      if (!root) return;
      syncCenter();
      if (!cfg.enabled || !cfg.overlay || !center) {
        root.style.display = "none";
        return;
      }

      applyDisplayMode();
      applyTheme();
      const m = visualMode();
      root.style.display = "block";
      // Keep the tracker fully opaque in any mode — its dimming is applied only to
      // the world-map base layer inside the canvas, so the widget itself (and the
      // aircraft/route) stay crisp rather than fading with the radar opacity.
      root.style.opacity =
        m === "background" || trackMode ? "1" : String(Math.min(1, cfg.opacity / 100));

      const err = root.querySelector(".sk-err");

      if (m === "minimized") {
        const pill = root.querySelector(".sk-pill");
        if (!pill) return;
        const lbl = center.label || center.icao || "SkyDesk";
        // Use the same filter (ground/entitlement-aware) and range the radar
        // uses, so the minimized count/range match GND mode instead of showing
        // the raw full-range cfg values.
        const list = SKRadar.filterAircraft(aircraft, { ...radarOpts(), maxBlips: 999 });
        const rng = fetchRangeNm();
        const gnd = isGroundActive() ? " · GND" : "";
        pill.textContent = `✈ ${lbl} · ${list.length}`;
        const title = titleEl();
        if (title) title.textContent = `${lbl}${gnd} · ${list.length} · ${rng}nm`;
        if (err) err.style.display = "none";
        return;
      }

      if (trackMode) {
        // The tracker is contained in the corner widget and kept fully opaque
        // (see opacity handling above). Tracker opacity is applied only to the
        // world-map base layer inside drawTrackCanvas, so the page isn't dimmed
        // and the aircraft/route stay crisp.
        root.querySelector(".sk-flight-card")?.classList.add("hidden");
        if (!worldReady) {
          ensureWorldData().then((ok) => {
            if (ok && trackMode) drawTrackCanvas();
          }).catch(() => {});
        }
        drawTrackCanvas();
        if (!trackPulse) startTrackLoops();
        const ttl = titleEl();
        const label = trackKind() === "tail" ? cfg.trackTail : cfg.trackFlight;
        if (ttl) ttl.textContent = trackStatusText || `Tracking ${label}`;
        if (err) err.style.display = "none";
        renderTrackStatus();
        return;
      }

      const target = SKRadar.filterAircraft(aircraft, radarOpts());
      selectedAc = resolveSelected(target);
      const emgCount = effectiveCfg().showEmergency !== false
        ? target.reduce((n, a) => n + (SKRadar.emergencyInfo(a) ? 1 : 0), 0)
        : 0;
      updateHead(target.length, emgCount);
      if ((tailWatch || cfg.tailWatch) && cfg.trackTail) {
        trackStatusText = trackStatusText || `Waiting for ${cfg.trackTail}…`;
        renderTrackStatus();
        const ttl = titleEl();
        if (ttl) ttl.textContent = trackStatusText;
      }
      updateFlightCard();
      if (err) err.style.display = "none";
      if (root.querySelector("canvas")) startRender();
    } catch (e) {
      console.warn("[SkyDesk] paint:", e);
    }
  }

  function settled(list, target, cx, cy, maxR, opts) {
    const byKey = new Map(target.map((a) => [SKRadar.acKey(a), a]));
    for (const d of list) {
      const n = byKey.get(SKRadar.acKey(d));
      if (!n) continue;
      const p = SKRadar.position(n, cx, cy, maxR, opts);
      const dx = (d._px == null ? p.x : d._px) - p.x;
      const dy = (d._py == null ? p.y : d._py) - p.y;
      if (Math.hypot(dx, dy) > 0.5) return false;
    }
    return true;
  }

  // Canvas-only redraw — no layout, menu-sync, or DOM writes. Used by the
  // per-frame render loop so sweep/interpolation stay cheap.
  function drawRadarOnly(listOverride) {
    if (!root || !center || !cfg.enabled || !cfg.overlay) return;
    if (trackMode) return;
    const m = visualMode();
    if (m === "minimized") return;
    const canvas = root.querySelector("canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = m === "background" ? innerWidth : cornerSize();
    const h = m === "background" ? innerHeight : cornerSize();
    if (m === "background") {
      const dpr = devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    const usePre = Array.isArray(listOverride);
    const src = usePre ? listOverride : aircraft;
    const opts = usePre ? { ...radarOpts(), usePrecomputed: true } : radarOpts();
    const list = SKRadar.draw(ctx, w, h, opts, airportForDraw(), src, resolveSelected(src), routeInfo);
    lastDrawList = list;
    lastDrawW = w;
    lastDrawH = h;
    selectedAc = resolveSelected(list);
  }

  function renderTick() {
    animId = null;
    if (!overlayActive()) {
      if (!isExtensionContextValid()) showExtensionReloadStatus();
      return;
    }
    if (!root || !cfg.enabled || !cfg.overlay || !center) return;
    if (trackMode) return;
    const m = visualMode();
    if (m === "minimized") return;

    const sweepActive = cfg.showSweep && !isGroundActive();
    if (sweepActive) sweepAngle = (sweepAngle + (m === "background" ? 1.4 : 2.2)) % 360;

    const opts = radarOpts();
    const w = m === "background" ? innerWidth : cornerSize();
    const h = m === "background" ? innerHeight : cornerSize();
    const cx = w / 2;
    const cy = h / 2;
    const maxR = SKRadar.maxRadius(w, h, opts);
    const target = SKRadar.filterAircraft(aircraft, opts);
    renderList = SKRadar.blendPositions(renderList, target, cx, cy, maxR, opts, EASE);
    drawRadarOnly(renderList);

    const hasEmg =
      cfg.showEmergency !== false && target.some((a) => SKRadar.emergencyInfo(a));
    if (sweepActive || hasEmg || !settled(renderList, target, cx, cy, maxR, opts)) startRender();
  }

  function startRender() {
    if (!overlayActive()) return;
    if (animId != null) return;
    animId = requestAnimationFrame(renderTick);
  }

  // Back-compat alias: callers used to (re)start the sweep animation.
  function startAnim() {
    startRender();
  }

  function syncFeedStatus(el) {
    const node = el || root?.querySelector(".sk-feed-status");
    if (!node) return;
    if (showingCachedFeed && fetching) {
      node.textContent = "Updating feed…";
      return;
    }
    if (feedFailStreak >= 3) {
      node.textContent = `Feed issues (${feedFailStreak}×) — retrying…`;
      return;
    }
    if (feedSource) {
      node.textContent = feedSource.includes("+") ? `Sources: ${feedSource}` : `Source: ${feedSource}`;
      return;
    }
    node.textContent = "";
  }

  function finishFetchLoop(req) {
    if (req !== fetchReq) return;
    clearTimeout(fetchWatchdog);
    fetchWatchdog = null;
    fetching = false;
    queueFetch();
  }

  // Tear down any in-flight fetch cleanly. Bumping fetchReq orphans the pending
  // sendMessage callback + watchdog (they bail on req !== fetchReq), then we
  // clear the watchdog and reset `fetching` ourselves. Without this, a schedule()
  // during an in-flight fetch would invalidate the request but leave fetching
  // stuck true forever (the orphaned callback never runs finishFetchLoop), and
  // the poll loop would spin fetchData→queueFetch with no network request.
  function abortInflightFetch() {
    if (!fetching && !fetchWatchdog) return;
    fetchReq++;
    clearTimeout(fetchWatchdog);
    fetchWatchdog = null;
    fetching = false;
  }

  function fetchData() {
    if (!overlayActive()) {
      if (!isExtensionContextValid()) showExtensionReloadStatus();
      return;
    }
    if (pageHidden) return;
    if (!cfg.enabled || !cfg.overlay) return;
    if (trackMode) return;
    syncCenter();
    if (!center) {
      queueFetch();
      return;
    }
    if (fetching) {
      // A consistent in-flight fetch has an armed watchdog — just re-queue and
      // let it complete. But `fetching` true with no watchdog is an orphaned
      // state (the request was invalidated and its callback bailed): recover by
      // aborting and falling through to start a fresh fetch.
      if (fetchWatchdog) {
        queueFetch();
        return;
      }
      abortInflightFetch();
    }

    const req = ++fetchReq;
    fetching = true;
    fetchStartedAt = Date.now();
    if (!initialFetchDone) paint();

    clearTimeout(fetchWatchdog);
    fetchWatchdog = setTimeout(() => {
      if (req !== fetchReq || !fetching) return;
      feedFailStreak++;
      showErr("Feed timeout — retrying");
      syncFeedStatus();
      paint();
      finishFetchLoop(req);
    }, FETCH_WATCHDOG_MS);

    try {
      chrome.runtime.sendMessage(
        { type: "fetch-aircraft", lat: center.lat, lon: center.lon, dist: fetchRangeNm() },
        (res) => {
          if (req !== fetchReq) return;
          initialFetchDone = true;
          if (runtimeLastError()) {
            feedFailStreak++;
            showErr("Extension idle — refresh page");
            syncFeedStatus();
            paint();
            finishFetchLoop(req);
            return;
          }
          if (!res?.ok) {
            feedFailStreak++;
            showErr(res?.error || "Feed unavailable");
            syncFeedStatus();
            paint();
            finishFetchLoop(req);
            return;
          }
          feedFailStreak = 0;
          const nextAc = (res.data?.ac || []).filter((a) => a.lat != null && a.lon != null);
          feedSource = res.source || "";
          showingCachedFeed = false;
          const sig = `${feedDataSig(nextAc)}|${feedSource}`;
          const feedUnchanged = sig === lastFeedSig && initialFetchDone;
          aircraft = nextAc;
          lastFeedSig = sig;
          if (!feedUnchanged) saveFeedCache(aircraft, feedSource);
          syncFeedStatus();
          if ((tailWatch || cfg.tailWatch) && cfg.trackTail) {
            tryEngageTail(cfg.trackTail);
          }
          if (!feedUnchanged) paint();
          finishFetchLoop(req);
        }
      );
    } catch (e) {
      feedFailStreak++;
      showErr("Feed error — retrying");
      syncFeedStatus();
      finishFetchLoop(req);
    }
  }

  // Schedule the next poll relative to when the *current* fetch started, so a
  // slow or failed request (e.g. multi-source stagger or OpenSky fallback)
  // doesn't add its own latency on top of the refresh interval. If the fetch
  // already took longer than the interval, fire again almost immediately.
  function queueFetch() {
    if (!overlayActive()) return;
    if (pageHidden || !cfg.enabled || !cfg.overlay || trackMode) return;
    clearTimeout(timer);
    const sec = Math.max(1, cfg.refreshSec || 2);
    const elapsed = fetchStartedAt ? Date.now() - fetchStartedAt : 0;
    const delay = Math.max(300, sec * 1000 - elapsed);
    timer = setTimeout(fetchData, delay);
  }

  function showErr(msg) {
    ensureMounted();
    if (!root) return;
    const err = root.querySelector(".sk-err");
    if (!err) return;
    err.textContent = msg;
    err.style.display = "block";
  }

  function schedule() {
    if (!overlayActive()) return;
    clearTimeout(timer);
    timer = null;
    // Abort any in-flight fetch so the fresh fetchData() issues a new
    // sendMessage instead of hitting the `fetching` guard (which would only
    // re-queue and never fire a request — the stall bug).
    abortInflightFetch();
    fetchData();
    startAnim();
  }

  function mergeSettings(s) {
    const beforeKey = `${cfg.centerLat},${cfg.centerLon},${fetchRangeNm()},${cfg.icao},${cfg.proGroundMode}`;
    cfg = { ...DEFAULTS, ...s };
    if (!MODES.includes(cfg.displayMode)) cfg.displayMode = "corner";
    if (cfg.displayMode !== "minimized") lastNonMinMode = cfg.displayMode;
    if (cfg.centerMode !== "airport" || !cfg.icao) cfg.proGroundMode = false;
    widgetSize = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Number(cfg.widgetSize) || SIZE));
    if (s.posX != null && s.posY != null) {
      pos.x = Number(s.posX);
      pos.y = Number(s.posY);
    }
    if (s.chromePos && s.chromePos.x != null) {
      chromePos = { x: Number(s.chromePos.x), y: Number(s.chromePos.y) };
    } else if (cfg.triggerPos && cfg.triggerPos.x != null) {
      chromePos = { x: Number(cfg.triggerPos.x), y: Number(cfg.triggerPos.y) };
    } else {
      chromePos = null;
    }
    cfg.chromePos = chromePos;
    syncCenter();
    // Apply entitlement limits before the first paint so a stored background mode
    // does not leave the root without sk-mode-* (and z-index) while entitlement
    // is still being fetched from the service worker.
    const entitledNow = !window.SKEntitlement || isEntitled();
    if (window.SKEntitlement && !entitledNow) {
      cfg = SKEntitlement.stripGatedCfg(cfg, false);
    }
    // Seed the transition tracker: if entitlement later resolves active, the next
    // enforceEntitlementFallback() sees inactive→active and restores stored cfg.
    wasEntitled = entitledNow;
    return (
      beforeKey !==
      `${cfg.centerLat},${cfg.centerLon},${fetchRangeNm()},${cfg.icao},${cfg.proGroundMode}`
    );
  }

  function apply(s) {
    const centerChanged = mergeSettings(s);

    if (!cfg.enabled || !cfg.overlay) {
      if (root) root.style.display = "none";
      clearTimeout(timer);
      cancelAnimationFrame(animId);
      return;
    }

    ensureMounted();
    bindDrag();
    bindResize();
    bindChromeDrag();
    bindCanvasInput();
    bindFlightPick();
    bindMenuControls();

    maybeSyncTrackMode();

    if (trackMode) {
      paint();
      return;
    }

    if (centerChanged) {
      clearFlightSelection();
      initialFetchDone = false;
      loadRunways();
      loadCachedFeed(() => {
        if (aircraft.length) initialFetchDone = true;
        paint();
        schedule();
      });
    } else {
      paint();
      if (cfg.enabled && cfg.overlay && !trackMode && timer == null) schedule();
    }
  }

  function onVisibilityChange() {
    pageHidden = document.hidden;
    if (!overlayActive()) {
      if (!isExtensionContextValid()) showExtensionReloadStatus();
      return;
    }
    if (pageHidden) {
      clearTimeout(timer);
      timer = null;
      // Abort rather than just clearing the timer, so no orphaned fetch state
      // (fetching=true with an invalidated request) survives the pause.
      abortInflightFetch();
      // Stop the tracker's network poll (~12s) + canvas pulse (~130ms) loops so
      // a backgrounded tab tracking a flight stops draining CPU/network/battery.
      if (trackMode) stopTrackLoops();
      stopTailWatchPoll();
      return;
    }
    if (trackMode) {
      // Resume tracking when the tab comes back into view, and refresh once
      // immediately so the map isn't stale for up to a full poll interval.
      startTrackLoops();
      if ((tailWatch || cfg.tailWatch) && cfg.trackTail) startTailWatchPoll();
      pollTrack();
      drawTrackCanvas();
    } else {
      if ((tailWatch || cfg.tailWatch) && cfg.trackTail) startTailWatchPoll();
      if (cfg.enabled && cfg.overlay) schedule();
    }
    refreshEntitlement().then(() => {
      maybeOfferWelcome();
      maybeOfferTrialTour();
    }).catch(handleContextError);
  }

  function pingMounted() {
    if (!overlayActive()) return;
    safeSendMessage({ type: "overlay-mounted" });
  }

  function boot() {
    try {
      if (!overlayActive()) {
        showExtensionReloadStatus();
        return;
      }

      const finishBoot = () => {
        if (!overlayActive()) return;
        if (selectedAc && routeInfo === null) fetchRouteFor(selectedAc);
        loadRunways();

        refreshEntitlement().then(async () => {
          if (!overlayActive()) return;
          if (cfg.viewMode === "tracker" && isEntitled()) {
            await restoreTrackPreview();
          }
          maybeSyncTrackMode();
          if (!trackMode) {
            paint();
            if (timer == null) schedule();
          }
          maybeOfferWelcome();
          maybeOfferTrialTour();
        }).catch(handleContextError);

        pingMounted();
        if (!window.__SKYDESK_ENTITLE_REFRESH) {
          window.__SKYDESK_ENTITLE_REFRESH = true;
          entitleRefreshInterval = setInterval(() => {
            if (!overlayActive()) {
              showExtensionReloadStatus();
              return;
            }
            refreshEntitlement().catch(handleContextError);
          }, 30 * 60 * 1000);
        }
        if (DEBUG) console.info("[SkyDesk] Widget mounted on", location.hostname);
      };

      const loadLocalAndApply = (sync, local) => {
        drainRuntimeLastError();
        if (local?.skEntitlementCache) {
          entitlement = { ...local.skEntitlementCache, ok: true };
        }
        apply(sync);
        applyFeedCacheHit(local?.[FEED_CACHE_KEY]);
        restoreSelectedAircraft(local);
        finishBoot();
      };

      if (!chrome.storage?.sync) {
        loadLocalAndApply({ ...DEFAULTS }, {});
        return;
      }

      chrome.storage.sync.get(DEFAULTS, (sync) => {
        drainRuntimeLastError();
        if (chrome.storage?.local) {
          chrome.storage.local.get(
            [FEED_CACHE_KEY, SELECTED_AC_KEY, "skEntitlementCache"],
            (local) => loadLocalAndApply(sync, local)
          );
        } else {
          loadLocalAndApply(sync, {});
        }
      });
    } catch (e) {
      console.warn("[SkyDesk] boot failed:", e);
    }
  }

  function waitForDom(fn, tries = 50) {
    if (document.body || document.documentElement) {
      fn();
      return;
    }
    if (tries <= 0) return;
    setTimeout(() => waitForDom(fn, tries - 1), 200);
  }

  // Re-mount if the host page tears our root out of the DOM. The `reMounting`
  // latch keeps a burst of mutation records (common on SPA pages like Google,
  // especially right after a trial/entitlement change re-renders the page) from
  // queuing several overlapping boot()s — the de-dupe above is the hard
  // guarantee, this just avoids the churn that could surface a second widget.
  let reMounting = false;
  const observer = new MutationObserver(() => {
    if (reMounting) return;
    if (cfg.enabled && cfg.overlay && !document.getElementById(TAG)) {
      reMounting = true;
      root = null;
      waitForDom(() => {
        try {
          boot();
        } finally {
          reMounting = false;
        }
      });
    }
  });

  function startObserver() {
    const target = document.documentElement || document.body;
    if (target) observer.observe(target, { childList: true, subtree: true });
  }

  waitForDom(() => {
    boot();
    startObserver();
  });

  try {
    chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "sync") return;
    // Ignore position/size-only echoes and our own debounced commits.
    if (skipNextSync) {
      skipNextSync = false;
      return;
    }
    const keys = Object.keys(ch);
    if (
      keys.length &&
      keys.every(
        (k) =>
          k === "posX" ||
          k === "posY" ||
          k === "widgetSize" ||
          k === "chromePos" ||
          k === "triggerPos"
      )
    ) {
      // Geometry-only change from another tab: adopt without a refetch.
      if ("chromePos" in ch) {
        const v = ch.chromePos.newValue;
        chromePos = v && v.x != null ? { x: Number(v.x), y: Number(v.y) } : null;
        cfg.chromePos = chromePos;
        if (root) applyChromeFloat();
      } else if ("triggerPos" in ch) {
        const v = ch.triggerPos.newValue;
        if (v && v.x != null && !chromePos) {
          chromePos = { x: Number(v.x), y: Number(v.y) };
          cfg.chromePos = chromePos;
        }
        cfg.triggerPos = v && v.x != null ? { x: Number(v.x), y: Number(v.y) } : null;
        if (root) applyChromeFloat();
      }
      if ("widgetSize" in ch) {
        widgetSize = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Number(ch.widgetSize.newValue) || SIZE));
        cfg.widgetSize = widgetSize;
        resizeCanvas();
        if (pos.x != null) placeCorner(pos.x, pos.y, false);
        startRender();
      }
      if ("posX" in ch && "posY" in ch && ch.posX.newValue != null) {
        pos.x = Number(ch.posX.newValue);
        pos.y = Number(ch.posY.newValue);
        if (mode() === "corner" || mode() === "minimized") placeCorner(pos.x, pos.y, false);
      }
      return;
    }
    chrome.storage.sync.get(DEFAULTS, apply);
  });
  } catch (e) {
    handleContextError(e);
  }

  try {
    chrome.runtime?.onMessage?.addListener((msg) => {
      if (msg.type === "settings-updated" && msg.settings) apply(msg.settings);
      if (msg.type === "entitlement-updated" && msg.state) {
        entitlement = msg.state;
        syncSubscriptionUI();
        enforceEntitlementFallback();
        maybeSyncTrackMode();
        paint();
        if (isEntitled()) {
          endWelcome(true);
          enableBackgroundAfterTrial();
        }
        maybeOfferTrialTour();
      }
      if (msg.type === "trial-started" && msg.state) {
        entitlement = msg.state;
        syncSubscriptionUI();
        enforceEntitlementFallback();
        maybeSyncTrackMode();
        paint();
        endWelcome(true);
        enableBackgroundAfterTrial();
        markTrialTourPending();
        maybeOfferTrialTour();
      }
    });
  } catch (_) {}

  addEventListener("resize", () => {
    if (!root) return;
    resizeCanvas();
    if (mode() === "corner" || mode() === "minimized") {
      if (pos.x != null) placeCorner(pos.x, pos.y, false);
    }
    paint();
  });

  document.addEventListener("visibilitychange", onVisibilityChange);
})();
