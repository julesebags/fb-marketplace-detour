const MSG = {
  fallback: "Open a listing to see its location.",
  staleScript:
    "Content script not responding. Reload the extension at chrome://extensions, then refresh this page.",
};

function el(id) {
  return document.getElementById(id);
}

function showFallback(message) {
  el("details").hidden = true;
  el("fallback").hidden = false;
  el("fallback").textContent = message;
}

function setField(id, value) {
  const node = el(id);
  node.textContent = value === null ? "Not found" : value;
  node.classList.toggle("missing", value === null);
}

function formatRadius(radiusKm) {
  if (typeof radiusKm !== "number" || !(radiusKm > 0)) return null;
  const rounded = radiusKm % 1 === 0 ? radiusKm : Number(radiusKm.toFixed(2));
  return `${rounded} km`;
}

function showDebug(info) {
  if (!info) return;
  el("debug").hidden = false;
  el("debug").textContent = [
    info.build || "no build",
    `listing ${info.isListingPage ? "y" : "n"}`,
    `static map ${info.staticMapFound ? "y" : "n"}`,
  ].join(" · ");
}

function render(info) {
  showDebug(info);

  if (!info || !info.location) {
    showFallback(MSG.fallback);
    return;
  }

  const { lat, lon, radiusKm } = info.location;

  el("fallback").hidden = true;
  el("details").hidden = false;

  setField("location-text", info.locationText || null);
  setField("coordinates", `${lat.toFixed(6)}, ${lon.toFixed(6)}`);
  setField("radius", formatRadius(radiusKm));
}

document.addEventListener("DOMContentLoaded", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || tab.id === undefined) {
      showFallback(MSG.fallback);
      return;
    }

    const onFacebook = /^https?:\/\/([a-z0-9-]+\.)*facebook\.com\//i.test(
      tab.url || ""
    );

    chrome.tabs.sendMessage(
      tab.id,
      { type: "MDR_GET_LISTING_INFO" },
      (response) => {
        if (chrome.runtime.lastError) {
          // On facebook.com this means a stale or missing content script;
          // anywhere else the script simply isn't meant to run.
          showFallback(onFacebook ? MSG.staleScript : MSG.fallback);
          return;
        }
        render(response);
      }
    );
  });
});
