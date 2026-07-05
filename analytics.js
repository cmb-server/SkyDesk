(function () {
  // Replace with your GA4 Measurement ID (Admin → Data streams → Web → Measurement ID)
  var GA_MEASUREMENT_ID = "G-XXXXXXXXXX";

  if (!GA_MEASUREMENT_ID || GA_MEASUREMENT_ID.indexOf("XXXX") !== -1) {
    return;
  }

  var script = document.createElement("script");
  script.async = true;
  script.src =
    "https://www.googletagmanager.com/gtag/js?id=" +
    encodeURIComponent(GA_MEASUREMENT_ID);
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    window.dataLayer.push(arguments);
  };
  gtag("js", new Date());
  gtag("config", GA_MEASUREMENT_ID, { anonymize_ip: true });

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

    installBtn.addEventListener("click", function () {
      gtag("event", "click_install", {
        event_category: "engagement",
        link_url: installBtn.href,
        outbound: true,
        ...utmParams(),
      });
    });
  });
})();
