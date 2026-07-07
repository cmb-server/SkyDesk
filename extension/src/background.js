importScripts(
  "lib/ExtPay.js",
  "lib/feed.js",
  "lib/runways-load.js",
  "lib/terminals-load.js",
  "lib/airport-info-load.js",
  "lib/airports-load.js",
  "lib/extension-analytics.js"
);

// Must match the extension id registered at https://extensionpay.com — see docs/EXTENSIONPAY_SETUP.md
const EXTENSIONPAY_ID = "skydesk";
const TRIAL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCAL_TRIAL_KEY = "skLocalTrialStartedAt";

(function initExtPay() {
  try {
    ExtPay(EXTENSIONPAY_ID).startBackground();
  } catch (e) {
    console.warn("[SkyDesk] ExtensionPay init failed:", e);
  }
})();

function toIsoDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString();
  const d = new Date(val);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function isTrialActive(trialStartedAt) {
  if (!trialStartedAt) return false;
  const started = new Date(trialStartedAt).getTime();
  return Number.isFinite(started) && Date.now() - started < TRIAL_MS;
}

function getLocalTrialStartedAt() {
  return new Promise((resolve) => {
    chrome.storage.local.get(LOCAL_TRIAL_KEY, (r) => resolve(r[LOCAL_TRIAL_KEY] || null));
  });
}

function setLocalTrialStartedAt(iso) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [LOCAL_TRIAL_KEY]: iso }, resolve);
  });
}

async function ensureLocalTrialStartedAt() {
  let started = await getLocalTrialStartedAt();
  if (!started) {
    started = new Date().toISOString();
    await setLocalTrialStartedAt(started);
  }
  return started;
}

async function migrateLocalTrial() {
  // Local trial is started explicitly via open-trial (ExtensionPay email signup or offline fallback).
}

function getCachedEntitlement() {
  return new Promise((resolve) => {
    chrome.storage.local.get("skEntitlementCache", (r) => {
      void chrome.runtime.lastError;
      resolve(r.skEntitlementCache || null);
    });
  });
}

function cacheEntitlement(state) {
  chrome.storage.local.set({ skEntitlementCache: { ...state, ts: Date.now() } });
}

// Authoritative entitlement built from an ExtPay getUser() that actually
// succeeded. Trust ExtPay's paid + server-side trial state ONLY — never grant a
// local trial here. The local 7-day trial is an offline-only fallback (see
// buildLocalTrialState). Granting it whenever ExtPay reports "free" is what let
// users mint unlimited free Pro by reinstalling / clearing chrome.storage.local.
function buildEntitlementState(extPayUser) {
  const paid = !!extPayUser?.paid;
  const extTrialStarted = toIsoDate(extPayUser?.trialStartedAt);
  const extTrialActive = !paid && isTrialActive(extTrialStarted);
  return {
    ok: true,
    active: paid || extTrialActive,
    paid,
    trialActive: extTrialActive,
    trialStartedAt: extTrialStarted,
    localTrial: false,
    subscriptionStatus: extPayUser?.subscriptionStatus || null,
    email: extPayUser?.email || null,
    extPayOk: true,
    extPayError: null,
  };
}

// Offline grace path: only reached when ExtPay is genuinely unreachable AND we
// have no prior known-good entitlement to preserve. Grants the local 7-day
// trial clock (anchored to install time when available) so a brand-new install
// during an ExtPay outage still works.
async function buildLocalTrialState(extPayError) {
  let localTrialStarted = await getLocalTrialStartedAt();
  if (!localTrialStarted) localTrialStarted = await ensureLocalTrialStartedAt();
  const localTrialActive = isTrialActive(localTrialStarted);
  return {
    ok: true,
    active: localTrialActive,
    paid: false,
    trialActive: localTrialActive,
    trialStartedAt: localTrialStarted,
    localTrial: localTrialActive,
    subscriptionStatus: null,
    email: null,
    extPayOk: false,
    extPayError: extPayError ? String(extPayError) : null,
  };
}

async function getEntitlementState() {
  let extPayUser = null;
  let extPayError = null;
  try {
    extPayUser = await ExtPay(EXTENSIONPAY_ID).getUser();
  } catch (e) {
    extPayError = e;
    console.warn("[SkyDesk] ExtensionPay getUser failed:", e);
  }

  // Transient ExtPay failure (e.g. network outage): NEVER downgrade. Preserve
  // the last-known-good cached entitlement and do NOT write/broadcast a
  // paid:false state — a paying user on a flaky connection must keep Pro. The
  // cache stores trialStartedAt, and entitlement.js recomputes trial liveness
  // live, so a stale trialActive flag can't over-grant past the 7-day window.
  if (extPayError) {
    const cached = await getCachedEntitlement();
    if (cached && cached.ok) return cached;
    // No prior state to preserve → treat ExtPay as genuinely unavailable and
    // grant the offline local-trial grace so a first run still works.
    try {
      const state = await buildLocalTrialState(extPayError);
      cacheEntitlement(state);
      return state;
    } catch (e) {
      console.warn("[SkyDesk] Local-trial fallback failed:", e);
      return { ok: false, active: false, paid: false, trialActive: false, error: String(e) };
    }
  }

  // Authoritative response from ExtPay — trust it (and only it).
  try {
    const state = buildEntitlementState(extPayUser);
    cacheEntitlement(state);
    return state;
  } catch (e) {
    console.warn("[SkyDesk] Entitlement build failed:", e);
    return { ok: false, active: false, paid: false, trialActive: false, error: String(e) };
  }
}

async function startLocalTrial() {
  const existing = await getLocalTrialStartedAt();
  if (!existing) {
    await setLocalTrialStartedAt(new Date().toISOString());
    SKAnalytics.track("trial_started", { source: "local" });
    // Drop stale cached "free" so offline grace applies for this first local trial.
    await new Promise((resolve) => chrome.storage.local.remove("skEntitlementCache", () => resolve()));
  }
  const state = await getEntitlementState();
  broadcastEntitlement(state);
  return state;
}

function broadcastEntitlement(state) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id && isHttpUrl(tab.url)) {
        chrome.tabs
          .sendMessage(tab.id, { type: "entitlement-updated", state })
          .catch(() => {});
      }
    }
  });
}

try {
  const extpay = ExtPay(EXTENSIONPAY_ID);
  extpay.onPaid.addListener((user) => {
    try {
      const plan =
        user?.plan?.unit || user?.plan?.interval || user?.plan?.nickname || "unknown";
      SKAnalytics.track("purchase", { plan: String(plan) });
    } catch (_) {}
    getEntitlementState().then(broadcastEntitlement).catch(() => {});
  });
  extpay.onTrialStarted.addListener(() => {
    SKAnalytics.track("trial_started", { source: "extpay" });
    getEntitlementState()
      .then((state) => {
        broadcastEntitlement(state);
        chrome.tabs.query({}, (tabs) => {
          for (const tab of tabs) {
            if (tab.id && isHttpUrl(tab.url)) {
              chrome.tabs
                .sendMessage(tab.id, { type: "trial-started", state })
                .catch(() => {});
            }
          }
        });
      })
      .catch(() => {});
  });
} catch (_) {}

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
  widgetSize: 248,
};

function isHttpUrl(url) {
  return typeof url === "string" && /^https?:\/\//.test(url);
}

// Resolve and cache the latest RainViewer radar frame (host + path). Cached for
// a few minutes so each tab's weather layer doesn't re-hit the metadata API.
let weatherFrames = null; // { host, path, ts }
async function getWeatherFrames() {
  if (weatherFrames && Date.now() - weatherFrames.ts < 3 * 60 * 1000) {
    return { ok: true, host: weatherFrames.host, path: weatherFrames.path };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch("https://api.rainviewer.com/public/weather-maps.json", {
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const past = data?.radar?.past || [];
    const nowcast = data?.radar?.nowcast || [];
    const frame = nowcast[0] || past[past.length - 1];
    if (!data?.host || !frame?.path) return { ok: false, error: "No radar frame" };
    weatherFrames = { host: data.host, path: frame.path, ts: Date.now() };
    return { ok: true, host: weatherFrames.host, path: weatherFrames.path };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function ensureDefaults(isInstall) {
  chrome.storage.sync.get(null, (cur) => {
    const icao = !cur.icao || cur.icao === "DOV" ? "DTW" : cur.icao;
    // Only force the widget on at first install. On "update" we must preserve a
    // user's enabled/overlay choice (re-enabling on every update is a bug) — the
    // stored values flow through via ...cur, defaulting to true only if absent.
    const patch = { ...DEFAULTS, ...cur, icao };
    if (isInstall) {
      patch.enabled = true;
      patch.overlay = true;
    }

    if (cur.centerLat == null || cur.centerLon == null) {
      patch.centerLat = DEFAULTS.centerLat;
      patch.centerLon = DEFAULTS.centerLon;
      patch.centerLabel = icao;
      patch.centerMode = "airport";
    }
    if (cur.blipStyle == null) patch.blipStyle = "plane";
    if (cur.tagFontSize == null) patch.tagFontSize = 9;
    if (cur.showSweep == null) patch.showSweep = false;
    if (cur.showType == null) patch.showType = false;
    if (cur.refreshSec == null) patch.refreshSec = 2;
    if (cur.showRangeRings == null) patch.showRangeRings = true;
    if (cur.showOuterRing == null) patch.showOuterRing = true;
    if (cur.showRunways == null) patch.showRunways = true;
    if (cur.displayMode == null) patch.displayMode = DEFAULTS.displayMode;
    if (cur.ringOpacity == null) patch.ringOpacity = 100;
    if (cur.showTagBg == null) patch.showTagBg = true;
    if (cur.proGroundMode == null) patch.proGroundMode = false;
    if (cur.groundRangeNm == null) patch.groundRangeNm = 2.5;
    if (cur.colorPlane == null) patch.colorPlane = DEFAULTS.colorPlane;
    if (cur.colorMilitary == null) patch.colorMilitary = DEFAULTS.colorMilitary;
    if (cur.colorTag == null) patch.colorTag = DEFAULTS.colorTag;
    if (cur.colorTagBg == null) patch.colorTagBg = DEFAULTS.colorTagBg;
    if (cur.colorAirport == null) patch.colorAirport = DEFAULTS.colorAirport;
    if (cur.colorRings == null) patch.colorRings = DEFAULTS.colorRings;
    if (cur.colorRunway == null) patch.colorRunway = DEFAULTS.colorRunway;
    if (cur.colorMenu == null) patch.colorMenu = DEFAULTS.colorMenu;
    if (cur.showEmergency == null) patch.showEmergency = DEFAULTS.showEmergency;
    if (cur.widgetSize == null) patch.widgetSize = DEFAULTS.widgetSize;
    if (cur.showWeather == null) patch.showWeather = false;
    if (cur.weatherOpacity == null) patch.weatherOpacity = DEFAULTS.weatherOpacity;
    if (cur.showTerrain == null) patch.showTerrain = false;
    if (cur.terrainOpacity == null) patch.terrainOpacity = DEFAULTS.terrainOpacity;
    if (cur.showWater == null) patch.showWater = false;
    if (cur.waterOpacity == null) patch.waterOpacity = DEFAULTS.waterOpacity;
    if (cur.showAirportDot == null) patch.showAirportDot = DEFAULTS.showAirportDot;
    if (cur.showHomeMarker == null) patch.showHomeMarker = DEFAULTS.showHomeMarker;
    if (cur.homeMarkerColor == null) patch.homeMarkerColor = DEFAULTS.homeMarkerColor;
    if (cur.homeMarkerOpacity == null) patch.homeMarkerOpacity = DEFAULTS.homeMarkerOpacity;

    chrome.storage.sync.set(patch);
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  ensureDefaults(details.reason === "install");
  SKAirportsLoad.ensureIndex().catch(() => {});
  const now = Date.now();
  if (details.reason === "install") {
    chrome.storage.local.set({
      skFirstInstall: now,
      skWelcomeDone: false,
    });
    SKAnalytics.track("extension_install");
  } else {
    migrateLocalTrial().catch(() => {});
  }
});

migrateLocalTrial().catch(() => {});

// Content scripts are injected declaratively (see manifest.json content_scripts),
// so no programmatic injection — and therefore no broad host permission or the
// "scripting" permission — is required. Tabs already open at install time pick
// up the radar on their next navigation or reload.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "get-entitlement") {
    getEntitlementState()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, active: false, error: String(e) }));
    return true;
  }

  if (msg.type === "open-subscription") {
    (async () => {
      try {
        const extpay = ExtPay(EXTENSIONPAY_ID);
        if (msg.plan) await extpay.openPaymentPage(msg.plan);
        else await extpay.openPaymentPage();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "open-trial") {
    (async () => {
      try {
        await ExtPay(EXTENSIONPAY_ID).openTrialPage("7-day");
        sendResponse({ ok: true });
      } catch (e) {
        try {
          const state = await startLocalTrial();
          sendResponse({ ok: true, localTrial: true, state });
        } catch (e2) {
          sendResponse({ ok: false, error: String(e2) });
        }
      }
    })();
    return true;
  }

  // NOTE: the old `reset-local-trial` message handler was removed. It let any
  // caller mint a fresh local trial (and was documented as a dev snippet), which
  // is an entitlement-bypass vector. The local trial clock is now only created
  // on install/offline-grace and is overridden by ExtPay's server-side state.

  if (msg.type === "fetch-aircraft") {
    const { lat, lon, dist } = msg;
    SKFeed.fetchAircraft(lat, lon, dist)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === "fetch-runways") {
    SKRunwaysLoad.fetchForIcao(msg.icao)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === "fetch-terminals") {
    SKTerminalsLoad.fetchForAirport(msg.icao, msg.lat, msg.lon)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === "fetch-airport-info") {
    SKAirportInfoLoad.fetchForIcao(msg.icao)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === "fetch-flight-route") {
    SKFeed.fetchRouteForCallsign(msg.callsign, msg.lat, msg.lon)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === "fetch-flight-trace") {
    SKFeed.fetchTrace(msg.hex, { recent: msg.recent !== false })
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === "fetch-flight") {
    (async () => {
      const cs = String(msg.flight || "").trim().toUpperCase();
      if (!cs) return { ok: false, error: "Enter a flight number" };
      const liveRes = await SKFeed.fetchCallsign(cs).catch((e) => ({ ok: false, error: String(e) }));
      let live = liveRes?.ok ? liveRes.live : null;
      if (!live && msg.liveHint && msg.liveHint.lat != null) live = msg.liveHint;

      // Resolve the route across callsign candidates so it still works when the
      // live lookup is down (adsb.lol outage) or the user typed an IATA number:
      // prefer the matched live callsign, then IATA→ICAO expansions, then raw.
      const candidates = [];
      const pushC = (v) => {
        if (v && !candidates.includes(v)) candidates.push(v);
      };
      pushC(live?.flight);
      pushC(liveRes?.matched);
      for (const c of SKFeed.expandCallsign(cs)) pushC(c);

      // Pass the matched aircraft's REAL current position (not 0,0) so the route
      // lookup can judge plausibility and pick the right leg, and so a stale
      // standing route that doesn't match where this plane is gets rejected
      // rather than chosen (RC3/RC5). When no live fix exists, lat/lon are
      // undefined and the plausibility logic skips gracefully.
      let route = null;
      for (const c of candidates) {
        const rr = await SKFeed.fetchRoute(c, live?.lat, live?.lon).catch(() => null);
        if (rr?.ok && rr.route && (rr.route.dep || rr.route.arr)) {
          route = rr.route;
          break;
        }
      }

      if (!live && !route) {
        return { ok: false, error: liveRes?.error || "Flight not found or not currently tracked" };
      }
      return { ok: true, callsign: live?.flight || candidates[0] || cs, live, route };
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === "fetch-tail") {
    (async () => {
      const tail = SKFeed.normalizeTail(msg.tail);
      if (!tail) return { ok: false, error: "Enter a tail number" };

      let live = msg.liveHint && msg.liveHint.lat != null ? msg.liveHint : null;
      let matched = tail;
      if (!live) {
        const liveRes = await SKFeed.fetchRegistration(tail).catch((e) => ({ ok: false, error: String(e) }));
        live = liveRes?.ok ? liveRes.live : null;
        matched = liveRes?.matched || tail;
        if (!live && liveRes && !liveRes.ok && liveRes.error) {
          return { ok: false, error: liveRes.error };
        }
      }

      const candidates = [];
      const pushC = (v) => {
        if (v && !candidates.includes(v)) candidates.push(v);
      };
      pushC(live?.flight);
      pushC(matched);
      for (const c of SKFeed.expandCallsign(live?.flight || "")) pushC(c);

      // Use the matched aircraft's REAL position (not 0,0) so plausibility/leg
      // selection work and a stale standing route is rejected (RC3/RC5).
      let route = null;
      for (const c of candidates) {
        const rr = await SKFeed.fetchRoute(c, live?.lat, live?.lon).catch(() => null);
        if (rr?.ok && rr.route && (rr.route.dep || rr.route.arr)) {
          route = rr.route;
          break;
        }
      }

      if (!live && !route) {
        return { ok: true, callsign: matched, live: null, route: null, waiting: true };
      }
      return { ok: true, callsign: live?.flight || matched, live, route, tail: matched };
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === "search-airports") {
    SKAirportsLoad.search(msg.query, msg.limit || 16)
      .then((results) => sendResponse({ ok: true, results }))
      .catch((e) => sendResponse({ ok: false, error: String(e), results: [] }));
    return true;
  }

  if (msg.type === "get-airport") {
    SKAirportsLoad.getByIcao(msg.icao)
      .then((airport) =>
        sendResponse(airport ? { ok: true, airport } : { ok: false, error: "Not found" })
      )
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === "weather-frames") {
    getWeatherFrames()
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === "validate-map-tile") {
    (async () => {
      try {
        const url = String(msg.url || "");
        if (!url.startsWith("https://server.arcgisonline.com/") && !url.includes("rainviewer.com")) {
          sendResponse({ ok: false, error: "Invalid tile URL" });
          return;
        }
        const minBytes = Math.max(500, Number(msg.minBytes) || 3200);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 7000);
        try {
          const r = await fetch(url, { cache: "force-cache", signal: ctrl.signal });
          if (!r.ok) {
            sendResponse({ ok: true, good: false });
            return;
          }
          const buf = await r.arrayBuffer();
          sendResponse({ ok: true, good: buf.byteLength > minBytes });
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "get-geojson") {
    // Fallback for content scripts on strict-CSP pages that can't fetch the
    // bundled map data directly. The service worker is exempt from page CSP.
    (async () => {
      try {
        const fetchJson = async (path) => {
          const r = await fetch(chrome.runtime.getURL(path));
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        };
        const [world, states] = await Promise.all([
          fetchJson("src/data/world-countries.geo.json"),
          fetchJson("src/data/us-states.geo.json"),
        ]);
        sendResponse({ ok: true, world, states });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "get-water") {
    // Fallback for content scripts on strict-CSP pages that can't fetch the
    // bundled water polygons directly. The service worker is exempt from page CSP.
    (async () => {
      try {
        const r = await fetch(chrome.runtime.getURL("src/data/water.geo.json"));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const water = await r.json();
        sendResponse({ ok: true, water });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "open-page") {
    // Only allow opening pages bundled inside the extension (with an optional
    // #fragment so callers can deep-link to a section, e.g. #track).
    const path = String(msg.path || "");
    if (/^src\/[\w./-]+\.html(#[\w-]+)?$/.test(path)) {
      chrome.tabs.create({ url: chrome.runtime.getURL(path) });
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: "Invalid path" });
    }
    return true;
  }

  if (msg.type === "overlay-mounted") {
    chrome.action.setBadgeText({ text: "ON" });
    chrome.action.setBadgeBackgroundColor({ color: "#2a7a4a" });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "settings-updated") {
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (tab.id && isHttpUrl(tab.url)) {
          chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
        }
      }
    });
    sendResponse({ ok: true });
    return true;
  }

  return false;
});
