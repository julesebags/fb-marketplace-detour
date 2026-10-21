// Drives a hidden worker tab so the user's own page is never touched.
//
// The sidebar in the user's tab sends DETOUR_REFRESH here; this worker
// opens its own Marketplace tab, marks it so geo-override.js spoofs
// geolocation in that tab only, runs the modal automation + scrape there,
// closes it, and returns the listings.

const LOG = "[DetourRouter][bg]";

// ---- the only place override coordinates are defined -------------------
const OVERRIDE_LAT = 40.7128;
const OVERRIDE_LON = -74.006;
const DEFAULT_RADIUS_KM = 5;

// When true, use the selected saved location from chrome.storage instead of
// the constants above.
const USE_SAVED_LOCATION = false;

// When true, leave the worker tab open so its console can be read.
const DEBUG_KEEP_WORKER_TAB = false;

// TODO: accept route-sampled coordinates per call so the worker can walk
// points along a route instead of using one fixed position.

// Chrome throttles hidden tabs: timers slow and lazy-loading can stall. If
// the feed comes back empty in "background-tab" mode, switch this to
// "unfocused-window", which gets a real (if unfocused) window and so is not
// throttled the same way.
const WORKER_MODE = "background-tab"; // or "unfocused-window"

const WORKER_BASE_URL = "https://www.facebook.com/marketplace/";
const TAB_LOAD_TIMEOUT_MS = 15000;
const PING_TIMEOUT_MS = 10000;
const PING_INTERVAL_MS = 500;
const OVERALL_TIMEOUT_MS = 45000;

let isRunning = false;
let workerTabId = null;

chrome.runtime.onInstalled.addListener(() => {
  console.log(`${LOG} installed`);
});

// Clicking the toolbar icon opens the docked side panel. There is no
// default_popup in the manifest, which is what lets this take effect.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(`${LOG} side panel setup failed`, error));

// --- helpers -------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// geo-override.js reads this marker at document_start and moves it into
// sessionStorage, which is scoped to this tab alone.
function buildWorkerUrl(lat, lon) {
  return `${WORKER_BASE_URL}#detour-geo=${lat},${lon}`;
}

async function resolveCoordinates() {
  if (!USE_SAVED_LOCATION) {
    return { lat: OVERRIDE_LAT, lon: OVERRIDE_LON, source: "constants" };
  }

  try {
    const data = await chrome.storage.local.get([
      "savedLocations",
      "activeLocationId",
    ]);
    const saved = Array.isArray(data.savedLocations) ? data.savedLocations : [];
    const active = saved.find(
      (entry) => entry && entry.id === data.activeLocationId
    );
    if (active && Number.isFinite(active.lat) && Number.isFinite(active.lon)) {
      return { lat: active.lat, lon: active.lon, source: "saved location" };
    }
    console.warn(
      `${LOG} USE_SAVED_LOCATION is on but no usable saved location is selected; falling back`
    );
  } catch (error) {
    console.warn(`${LOG} could not read saved locations`, error);
  }

  return { lat: OVERRIDE_LAT, lon: OVERRIDE_LON, source: "constants" };
}

async function createWorker(url) {
  if (WORKER_MODE === "unfocused-window") {
    const win = await chrome.windows.create({
      url,
      focused: false,
      type: "popup",
      width: 500,
      height: 800,
    });
    const tab = win.tabs && win.tabs[0];
    return { tabId: tab ? tab.id : null, windowId: win.id };
  }

  const tab = await chrome.tabs.create({ url, active: false });
  return { tabId: tab.id, windowId: null };
}

async function closeWorker(worker) {
  if (!worker) return;

  if (DEBUG_KEEP_WORKER_TAB) {
    console.log(
      `${LOG} DEBUG_KEEP_WORKER_TAB is on — leaving worker tab ${worker.tabId} open. ` +
        "Switch to it to read the [geo] and step A-H logs."
    );
    return;
  }

  try {
    if (worker.windowId != null) {
      await chrome.windows.remove(worker.windowId);
    } else if (worker.tabId != null) {
      await chrome.tabs.remove(worker.tabId);
    }
    console.log(`${LOG} worker closed`);
  } catch (error) {
    // Already gone; nothing to clean up.
    console.log(`${LOG} worker already closed`);
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve(value);
    };

    // Require the marketplace URL as well as "complete": a tab can report
    // complete for an interstitial before the real page lands.
    const looksReady = (tab) =>
      tab &&
      tab.status === "complete" &&
      typeof tab.url === "string" &&
      tab.url.includes("/marketplace");

    const onUpdated = (id, _info, tab) => {
      if (id === tabId && looksReady(tab)) finish(true);
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    const timer = setTimeout(() => finish(false), timeoutMs);

    // It may already be loaded before the listener attached.
    chrome.tabs.get(tabId).then(
      (tab) => {
        if (looksReady(tab)) finish(true);
      },
      () => {}
    );
  });
}

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ __noReceiver: true, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { __noReceiver: true, error: "empty response" });
      });
    } catch (error) {
      resolve({ __noReceiver: true, error: String(error) });
    }
  });
}

// Content scripts may not be listening the instant a tab reports complete.
async function waitForContentScript(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await sendToTab(tabId, { type: "DETOUR_PING" });
    if (response && response.ready) return true;
    await sleep(PING_INTERVAL_MS);
  }
  return false;
}

// --- the run -------------------------------------------------------------

async function runWorker({ lat, lon, radiusKm }) {
  if (isRunning) {
    console.warn(`${LOG} refresh ignored: a run is already in progress`);
    return { ok: false, listings: [], error: "already running" };
  }
  isRunning = true;

  let worker = null;

  const doRun = async () => {
    const url = buildWorkerUrl(lat, lon);
    worker = await createWorker(url);
    if (!worker.tabId) throw new Error("could not create the worker tab");
    workerTabId = worker.tabId;
    console.log(`${LOG} worker tab ${worker.tabId} created (${WORKER_MODE}) at ${url}`);

    const loaded = await waitForTabComplete(worker.tabId, TAB_LOAD_TIMEOUT_MS);
    if (!loaded) throw new Error("worker tab did not finish loading");
    console.log(`${LOG} worker tab loaded`);

    const ready = await waitForContentScript(worker.tabId, PING_TIMEOUT_MS);
    if (!ready) throw new Error("worker content script never answered a ping");
    console.log(`${LOG} worker content script ready`);

    // The worker verifies the spoof took before applying anything, so a
    // failure here means wrong-location results were prevented, not missed.
    const result = await sendToTab(worker.tabId, {
      type: "DETOUR_RUN_WORKER",
      lat,
      lon,
      radiusKm,
    });
    if (result && result.__noReceiver) {
      throw new Error(result.error || "worker stopped responding");
    }

    return {
      ok: !!(result && result.ok),
      listings: (result && result.listings) || [],
      error: (result && result.error) || null,
    };
  };

  try {
    const result = await withTimeout(doRun(), OVERALL_TIMEOUT_MS, "worker run");
    if (result.ok) {
      console.log(`${LOG} run finished: ok listings=${result.listings.length}`);
    } else {
      console.error(
        `${LOG} run finished NOT ok: ${result.error || "unknown"} ` +
          `(listings=${result.listings.length})`
      );
    }
    return result;
  } catch (error) {
    const message = String((error && error.message) || error);
    console.error(`${LOG} run failed: ${message}`);
    return { ok: false, listings: [], error: message };
  } finally {
    // Always, including on timeout: a stranded tab is worse than no result.
    await closeWorker(worker);
    workerTabId = null;
    isRunning = false;
  }
}

// --- messages ------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  if (message.type === "DETOUR_AM_I_WORKER") {
    const isWorker = !!(
      sender.tab &&
      workerTabId !== null &&
      sender.tab.id === workerTabId
    );
    sendResponse({ isWorker });
    return false;
  }

  if (message.type === "DETOUR_REFRESH") {
    (async () => {
      const coords = await resolveCoordinates();
      const radiusKm = message.radiusKm || DEFAULT_RADIUS_KM;
      console.log(
        `${LOG} using lat=${coords.lat} lon=${coords.lon} radius=${radiusKm}km source=${coords.source}`
      );
      const result = await runWorker({
        lat: coords.lat,
        lon: coords.lon,
        radiusKm,
      });
      sendResponse(result);
    })();
    return true; // responding asynchronously
  }

  return false;
});
