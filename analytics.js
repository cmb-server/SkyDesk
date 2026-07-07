(function () {
  // Base gtag is loaded inline in index.html so Google Ads can verify the tag.
  // This file only wires the install button + click_install conversion event.

  function utmParams() {
    var params = new URLSearchParams(window.location.search);
    return {
      campaign: params.get("utm_campaign") || undefined,
      source: params.get("utm_source") || undefined,
      medium: params.get("utm_medium") || undefined,
      term: params.get("utm_term") || undefined,
      content: params.get("utm_content") || undefined,
    };
  }

  function onReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else {
      fn();
    }
  }

  onReady(function () {
    var installBtn = document.getElementById("install-skydesk");
    if (!installBtn) return;

    // Pass ad attribution (UTM / gclid) through to the Web Store listing URL
    var pageParams = new URLSearchParams(window.location.search);
    var passKeys = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid"];
    try {
      var storeUrl = new URL(installBtn.href);
      passKeys.forEach(function (key) {
        if (pageParams.has(key)) storeUrl.searchParams.set(key, pageParams.get(key));
      });
      installBtn.href = storeUrl.toString();
    } catch (_) {}

    installBtn.addEventListener("click", function () {
      if (typeof window.gtag !== "function") return;
      window.gtag("event", "click_install", {
        event_category: "engagement",
        link_url: installBtn.href,
        outbound: true,
        ...utmParams(),
      });
    });
  });
})();
