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
    } catch (_) {}
  }

  return { track };
})();
