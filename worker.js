// Runs inside the hidden worker tab. The background service worker drives
// it; this script just answers pings and performs one run on request.
//
// Reuses applyOverriddenLocation() and scrapeFeedListings() unchanged.
(function () {
  "use strict";

  const NS = (window.DetourRouter = window.DetourRouter || {});
  const LOG = "[DetourRouter][worker]";

  if (window.__detourWorkerInstalled) return;
  window.__detourWorkerInstalled = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return false;

    // The background pings until this answers, because a content script is
    // not necessarily listening the moment the tab reports "complete".
    if (message.type === "DETOUR_PING") {
      sendResponse({ ready: true });
      return false;
    }

    if (message.type !== "DETOUR_RUN_WORKER") return false;

    (async () => {
      try {
        if (typeof NS.applyOverriddenLocation !== "function") {
          throw new Error("applyOverriddenLocation not loaded");
        }

        const result = await NS.applyOverriddenLocation({
          lat: message.lat,
          lon: message.lon,
          radiusKm: message.radiusKm,
        });
        const ok = !!(result && result.ok);
        const error = (result && result.error) || null;

        // Only scrape when the location actually took. Scraping after a
        // failed step D would hand back listings from the wrong place and
        // look like success.
        const listings =
          ok && NS.scrapeFeedListings ? NS.scrapeFeedListings() : [];

        console.log(
          `${LOG} run complete: ok=${ok} listings=${listings.length}` +
            (error ? ` error=${error}` : "")
        );
        sendResponse({ ok, listings, error });
      } catch (error) {
        console.error(`${LOG} run threw`, error);
        sendResponse({ ok: false, listings: [], error: String(error) });
      }
    })();

    return true; // responding asynchronously
  });

  console.log(`${LOG} listener installed`);
})();
