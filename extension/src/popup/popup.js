const DEFAULTS = { overlay: true, enabled: true };

const $ = (id) => document.getElementById(id);

function save(patch) {
  chrome.storage.sync.get(DEFAULTS, (cur) => {
    const next = { ...cur, ...patch };
    chrome.storage.sync.set(next, () => {
      chrome.runtime.sendMessage({ type: "settings-updated", settings: next });
    });
  });
}

function load() {
  chrome.storage.sync.get(DEFAULTS, (s) => {
    $("overlay").checked = s.overlay !== false && s.enabled !== false;
  });
  chrome.storage.local.get(["skWelcomeDone"], (s) => {
    const box = $("welcomeBox");
    if (box && !s?.skWelcomeDone) box.classList.remove("hidden");
  });
}

$("overlay").addEventListener("change", (e) => {
  const on = e.target.checked;
  // Don't write the gated displayMode:"background" here — the popup has no
  // entitlement context. The overlay's enable path / entitlement enforcement
  // decides the display mode (background only when entitled).
  save({ overlay: on, enabled: on });
});

$("openWindow").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/window/window.html") });
});

$("testPage").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://example.com" });
});

$("privacyLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("src/privacy/privacy.html") });
});

$("termsLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("src/privacy/terms.html") });
});

function checkTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const url = tabs[0]?.url || "";
    const isNewTab =
      url.startsWith("chrome://") ||
      url.startsWith("chrome-search://") ||
      url.includes("/_/chrome/newtab");
    const blocked = isNewTab || !/^https?:\/\//i.test(url);
    const warn = $("tabWarn");
    if (!blocked) {
      warn.hidden = true;
      return;
    }
    warn.hidden = false;
    warn.textContent = isNewTab
      ? "This tab is Chrome's New Tab. Extensions can't run here — open any normal website."
      : "SkyDesk only runs on regular http/https pages.";
  });
}

load();
checkTab();
