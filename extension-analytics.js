// Drop-in for SkyDesk extension: src/lib/extension-analytics.js
// Wire in background.js via importScripts("lib/extension-analytics.js")
//
// Tracks funnel events (install → trial → purchase) via GA4 Measurement Protocol.
// No page content, email, or browsing history is sent.
//
// Setup:
// 1. GA4 Admin → Data streams → Web → copy Measurement ID
// 2. GA4 Admin → same stream → Measurement Protocol API secrets → Create
// 3. Replace placeholders below
// 4. Mark events as key events in GA4: extension_install, trial_started, purchase
// 5. Import those key events into Google Ads as conversions

const SKAnalytics = (() => {
  const MEASUREMENT_ID = "G-B9YH62KXCV";
  const API_SECRET = "YOUR_API_SECRET";
  const CLIENT_ID_KEY = "skGaClientId";

  function configured() {
    return (
      MEASUREMENT_ID &&
      API_SECRET &&
      MEASUREMENT_ID.indexOf("XXXX") === -1 &&
      API_SECRET.indexOf("YOUR_") === -1
    );
  }

  async function clientId() {
    const stored = await chrome.storage.local.get(CLIENT_ID_KEY);
    if (stored[CLIENT_ID_KEY]) return stored[CLIENT_ID_KEY];
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ [CLIENT_ID_KEY]: id });
    return id;
  }

  async function track(eventName, params) {
    if (!configured()) return;
    try {
      const url =
        "https://www.google-analytics.com/mp/collect?measurement_id=" +
        encodeURIComponent(MEASUREMENT_ID) +
        "&api_secret=" +
        encodeURIComponent(API_SECRET);
      await fetch(url, {
        method: "POST",
        body: JSON.stringify({
          client_id: await clientId(),
          events: [
            {
              name: eventName,
              params: Object.assign({ engagement_time_msec: 100 }, params || {}),
            },
          ],
        }),
      });
    } catch (_) {
      // Analytics must never break the extension
    }
  }

  return { track };
})();

// --- background.js integration (copy these hooks) ---
//
// importScripts(..., "lib/extension-analytics.js");
//
// chrome.runtime.onInstalled.addListener((details) => {
//   ...
//   if (details.reason === "install") SKAnalytics.track("extension_install");
// });
//
// extpay.onTrialStarted.addListener(() => {
//   SKAnalytics.track("trial_started");
//   ...
// });
//
// extpay.onPaid.addListener((user) => {
//   SKAnalytics.track("purchase", {
//     plan: user?.plan?.unit || user?.plan?.interval || "unknown",
//   });
//   ...
// });
//
// When local trial starts (startLocalTrial), also:
//   SKAnalytics.track("trial_started", { source: "local" });
