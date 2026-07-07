// Shared subscription / trial constants (content scripts + service worker).
//
// Entitlement matrix (post-trial free tier vs trial/subscription):
// ┌─────────────────────────────┬──────────┬─────────────────┐
// │ Feature                     │ Free     │ Trial / paid    │
// ├─────────────────────────────┼──────────┼─────────────────┤
// │ Watch an airport            │ yes      │ yes             │
// │ Corner widget + minimized   │ yes      │ yes             │
// │ Basic radar (blips, tags…)  │ yes      │ yes             │
// │ Shift+click info card       │ yes      │ yes             │
// │ Runways + airport marker    │ yes      │ yes             │
// │ Watch lat/long              │ no       │ yes             │
// │ Overhead traffic highlight  │ no       │ yes (coords)    │
// │ Use my location             │ no       │ yes             │
// │ Full background display     │ no       │ yes             │
// │ Track flight / tail         │ no       │ yes             │
// │ Weather / terrain / water   │ no       │ yes             │
// │ Ground mode                 │ no       │ yes             │
// │ Emergency squawks           │ no       │ yes             │
// │ Shift+click route path      │ no       │ yes             │
// │ Flight path tracking toggle │ no       │ yes             │
// └─────────────────────────────┴──────────┴─────────────────┘
window.SKEntitlement = (() => {
  const TRIAL_DAYS = 7;
  const TRIAL_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000;

  const DEFAULT_AIRPORT = {
    icao: "DTW",
    centerLat: 42.21377,
    centerLon: -83.353786,
    centerLabel: "DTW",
  };

  // Boolean cfg keys gated after the 7-day trial (see pro.js FEATURES).
  const GATED_CFG_KEYS = new Set([
    "proFlightTrack",
    "proGroundMode",
    "showWeather",
    "showTerrain",
    "showWater",
    "showEmergency",
    "showOverheadHighlight",
  ]);

  function trialActive(user) {
    if (!user?.trialStartedAt) return false;
    const started =
      user.trialStartedAt instanceof Date
        ? user.trialStartedAt.getTime()
        : new Date(user.trialStartedAt).getTime();
    return Number.isFinite(started) && Date.now() - started < TRIAL_MS;
  }

  // Recompute the trial window live from `trialStartedAt` rather than trusting a
  // cached `active`/`trialActive` boolean. A persisted skEntitlementCache can
  // outlive the 7-day trial (cache still says active:true), which would
  // over-grant pro after the trial expires. Reusing TRIAL_MS keeps the trial
  // duration identical to background.js (both 7 days).
  function trialStillLive(state) {
    if (!state?.trialStartedAt) return false;
    const started =
      state.trialStartedAt instanceof Date
        ? state.trialStartedAt.getTime()
        : new Date(state.trialStartedAt).getTime();
    return Number.isFinite(started) && Date.now() - started < TRIAL_MS;
  }

  function isActive(state) {
    if (!state) return false;
    if (state.paid) return true;
    // When we have a trial timestamp, the live computation is authoritative and
    // ignores any stale cached active/trialActive flag.
    if (state.trialStartedAt) return trialStillLive(state);
    // No timestamp to verify against (e.g. entitlement not yet resolved): fall
    // back to the cached flag.
    return !!(state.active || state.trialActive);
  }

  function canUseCoordsMode(state) {
    return isActive(state);
  }

  function canWatchLocation(state) {
    return canUseCoordsMode(state);
  }

  function canUseTrackMode(state) {
    return isActive(state);
  }

  function canUseBackgroundMode(state) {
    return isActive(state);
  }

  function stripGatedCfg(cfg, entitled) {
    if (entitled || !cfg) return cfg;
    const out = { ...cfg };
    for (const key of GATED_CFG_KEYS) {
      if (key in out) out[key] = false;
    }
    if (out.viewMode === "tracker") {
      out.viewMode = "radar";
      out.trackFlight = "";
      out.trackTail = "";
      out.tailWatch = false;
    }
    if (out.centerMode === "coords") {
      out.centerMode = "airport";
      if (!(out.icao || "").trim()) {
        Object.assign(out, DEFAULT_AIRPORT);
      }
    }
    if (out.displayMode === "background") {
      out.displayMode = "corner";
    }
    return out;
  }

  function cfgKeyGated(key) {
    return GATED_CFG_KEYS.has(key);
  }

  function cfgValueRequiresEntitlement(key, val) {
    if (key === "displayMode") return val === "background";
    if (key === "centerMode") return val === "coords";
    return cfgKeyGated(key) && !!val;
  }

  function statusLabel(state) {
    if (!state) return "Checking subscription…";
    if (state.paid) {
      if (state.subscriptionStatus === "past_due") return "Payment past due — update billing";
      if (state.subscriptionStatus === "canceled") return "Subscription ended";
      return "Subscription active";
    }
    if (state.trialStartedAt && trialStillLive(state)) {
      const left = Math.max(0, TRIAL_MS - (Date.now() - new Date(state.trialStartedAt).getTime()));
      const days = Math.ceil(left / (24 * 60 * 60 * 1000));
      return days > 1 ? `${days}-day trial remaining` : "Trial ends today";
    }
    if (state.trialStartedAt) return "Trial ended — subscribe to continue";
    return "7-day free trial available";
  }

  return {
    TRIAL_DAYS,
    TRIAL_MS,
    DEFAULT_AIRPORT,
    GATED_CFG_KEYS,
    trialActive,
    isActive,
    canUseCoordsMode,
    canWatchLocation,
    canUseTrackMode,
    canUseBackgroundMode,
    stripGatedCfg,
    cfgKeyGated,
    cfgValueRequiresEntitlement,
    statusLabel,
  };
})();

// Shared guards for content scripts after an extension reload/update leaves stale
// injected scripts on open tabs (chrome.runtime APIs throw "Extension context invalidated").
window.SKExtension = (() => {
  const RELOAD_MSG = "Refresh page — SkyDesk was updated";

  function isContextValid() {
    return !!chrome.runtime?.id;
  }

  function isContextInvalidatedError(err) {
    const msg = err?.message || String(err || "");
    return /extension context invalidated/i.test(msg);
  }

  function sendMessage(msg) {
    return new Promise((resolve) => {
      if (!isContextValid()) {
        resolve({ ok: false, contextLost: true });
        return;
      }
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime?.lastError;
          resolve(res ?? { ok: false });
        });
      } catch (e) {
        if (isContextInvalidatedError(e)) {
          resolve({ ok: false, contextLost: true });
        } else {
          resolve({ ok: false, error: e });
        }
      }
    });
  }

  return { RELOAD_MSG, isContextValid, isContextInvalidatedError, sendMessage };
})();
