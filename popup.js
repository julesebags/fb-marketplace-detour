const MSG = {
  fallback: "Open a listing to see its location.",
  staleScript:
    "Content script not responding. Reload the extension at chrome://extensions, then refresh this page.",
  geoDenied:
    "Location access denied — you can still manage saved locations below.",
  geoUnavailable:
    "Couldn't determine your location — you can still manage saved locations below.",
  geoTimeout:
    "Timed out getting your location — you can still manage saved locations below.",
  addressNotFound: "Couldn't find that address — try being more specific.",
  addressFailed:
    "Address lookup failed — check your connection and try again.",
  noToken: "Paste your Mapbox token into config.js to look up addresses.",
  addressUnavailable: "Address unavailable",
};

const STORAGE_KEYS = {
  saved: "savedLocations",
  active: "activeLocationId",
};

const MAPBOX_BASE = "https://api.mapbox.com/geocoding/v5/mapbox.places";
const PLACEHOLDER_TOKEN = "PASTE_MAPBOX_TOKEN_HERE";
const GEOCODE_TIMEOUT_MS = 8000;
const SUGGESTION_LIMIT = 5;
const MIN_QUERY_LENGTH = 3;
const DEBOUNCE_MS = 300;

// --- pure state helpers (exercised by the Node tests) -------------------

function plausibleCoords(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

function normaliseSaved(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry) =>
        entry &&
        typeof entry.id === "string" &&
        typeof entry.label === "string" &&
        Number.isFinite(entry.lat) &&
        Number.isFinite(entry.lon)
    )
    .map((entry) => ({
      ...entry,
      // Entries saved before addresses existed have none; keep them.
      address:
        typeof entry.address === "string" && entry.address.trim()
          ? entry.address
          : null,
    }));
}

function makeLocation(label, lat, lon, address, now) {
  return {
    id:
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `loc-${now}-${Math.random().toString(36).slice(2, 8)}`,
    label,
    address: address || null,
    lat,
    lon,
    createdAt: now,
  };
}

// Append, never overwrite.
function addLocation(saved, entry) {
  return saved.concat([entry]);
}

function removeLocation(saved, id) {
  return saved.filter((entry) => entry.id !== id);
}

// Deleting the active entry leaves nothing active.
function activeAfterRemoval(activeId, removedId) {
  return activeId === removedId ? null : activeId;
}

function formatCoords(lat, lon) {
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

function describeEntry(entry) {
  return `${entry.label} — ${entry.address || MSG.addressUnavailable}`;
}

// --- Mapbox geocoding ---------------------------------------------------

// MAPBOX_TOKEN is a global declared by config.js, loaded before this file.
// It is gitignored, so it may legitimately be missing on a fresh clone --
// hence the typeof guard rather than a direct reference.
function mapboxToken() {
  if (typeof MAPBOX_TOKEN === "undefined") return null;
  const token = String(MAPBOX_TOKEN).trim();
  if (!token || token === PLACEHOLDER_TOKEN) return null;
  return token;
}

// Mapbox returns coordinates as [longitude, latitude] -- reversed from the
// lat/lon order used everywhere else in this project.
function coordsFromFeature(feature) {
  if (!feature) return null;
  const pair = Array.isArray(feature.center)
    ? feature.center
    : feature.geometry && Array.isArray(feature.geometry.coordinates)
      ? feature.geometry.coordinates
      : null;
  if (!pair || pair.length < 2) return null;

  const lon = Number(pair[0]);
  const lat = Number(pair[1]);
  return plausibleCoords(lat, lon) ? { lat, lon } : null;
}

function firstFeature(payload) {
  return payload && Array.isArray(payload.features) && payload.features.length
    ? payload.features[0]
    : null;
}

async function mapboxRequest(pathSegment, params, externalSignal) {
  const token = mapboxToken();
  if (!token) {
    const err = new Error(MSG.noToken);
    err.kind = "no-token";
    throw err;
  }

  const search = new URLSearchParams({ access_token: token, ...(params || {}) });
  const url = `${MAPBOX_BASE}/${pathSegment}.json?${search.toString()}`;

  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS)
    : null;

  // A newer keystroke cancels this request through externalSignal.
  const onAbort = () => controller && controller.abort();
  if (externalSignal && controller) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onAbort);
  }

  try {
    const response = await fetch(
      url,
      controller ? { signal: controller.signal } : undefined
    );
    if (!response.ok) {
      const err = new Error(`Mapbox responded ${response.status}`);
      err.kind = "http";
      throw err;
    }
    return await response.json();
  } finally {
    if (timer) clearTimeout(timer);
    if (externalSignal && controller) {
      externalSignal.removeEventListener("abort", onAbort);
    }
  }
}

// Returns up to SUGGESTION_LIMIT candidates for the user to choose between.
// Nothing is picked automatically: a partial query matching the wrong place
// is exactly the bug this replaces.
async function geocodeSuggestions(query, options) {
  const opts = options || {};
  const params = {
    limit: String(SUGGESTION_LIMIT),
    autocomplete: "true",
  };

  // Bias toward the active saved location so nearby matches rank first.
  // Mapbox wants lon,lat here too.
  if (opts.proximity && plausibleCoords(opts.proximity.lat, opts.proximity.lon)) {
    params.proximity = `${opts.proximity.lon},${opts.proximity.lat}`;
  }

  const payload = await mapboxRequest(
    encodeURIComponent(query),
    params,
    opts.signal
  );

  const features =
    payload && Array.isArray(payload.features) ? payload.features : [];
  return features
    .map((feature) => {
      const coords = coordsFromFeature(feature);
      if (!coords) return null;
      return {
        lat: coords.lat,
        lon: coords.lon,
        address: feature.place_name || null,
      };
    })
    .filter(Boolean);
}

// Note the lon,lat order in the path. Returns a place name or null.
async function reverseGeocode(lat, lon) {
  const payload = await mapboxRequest(`${lon},${lat}`, { limit: "1" });
  const feature = firstFeature(payload);
  return feature && feature.place_name ? feature.place_name : null;
}

// --- storage ------------------------------------------------------------

async function loadState() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.saved,
    STORAGE_KEYS.active,
  ]);
  const saved = normaliseSaved(data[STORAGE_KEYS.saved]);
  const rawActive = data[STORAGE_KEYS.active];
  const activeId =
    typeof rawActive === "string" && saved.some((e) => e.id === rawActive)
      ? rawActive
      : null;
  return { saved, activeId };
}

async function saveState(saved, activeId) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.saved]: saved,
    [STORAGE_KEYS.active]: activeId,
  });
}

// --- DOM ----------------------------------------------------------------

function el(id) {
  return document.getElementById(id);
}

let state = { saved: [], activeId: null };
let pending = null;

function renderSavedList() {
  const list = el("saved-list");
  list.textContent = "";
  el("saved-empty").hidden = state.saved.length > 0;

  for (const entry of state.saved) {
    const row = document.createElement("li");
    row.className = "saved-row";
    if (entry.id === state.activeId) row.classList.add("is-active");

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "active-location";
    radio.id = `active-${entry.id}`;
    radio.checked = entry.id === state.activeId;
    radio.addEventListener("change", () => setActive(entry.id));

    const label = document.createElement("label");
    label.className = "saved-label";
    label.htmlFor = radio.id;

    // textContent throughout: labels and addresses are untrusted input and
    // must never be interpreted as markup.
    const primary = document.createElement("span");
    primary.className = "saved-name";
    primary.textContent = describeEntry(entry);

    const coords = document.createElement("span");
    coords.className = "saved-coords";
    coords.textContent = formatCoords(entry.lat, entry.lon);

    // Later features need the raw numbers; keep them reachable.
    label.title = `${entry.lat}, ${entry.lon}`;
    label.append(primary, coords);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Delete ${entry.label}`);
    remove.title = `Delete ${entry.label}`;
    remove.addEventListener("click", () => deleteLocation(entry.id));

    row.append(radio, label, remove);
    list.append(row);
  }
}

async function setActive(id) {
  state.activeId = id;
  await saveState(state.saved, state.activeId);
  renderSavedList();
}

async function deleteLocation(id) {
  state.saved = removeLocation(state.saved, id);
  state.activeId = activeAfterRemoval(state.activeId, id);
  await saveState(state.saved, state.activeId);
  renderSavedList();
}

// Both entry paths funnel here: confirm, label, save.
function showCapture(candidate) {
  pending = candidate;
  el("capture").hidden = false;
  el("captured-address").textContent =
    candidate.address || MSG.addressUnavailable;
  el("captured-coords").textContent = formatCoords(
    candidate.lat,
    candidate.lon
  );
  el("label-input").focus();
}

function hideCapture() {
  pending = null;
  el("capture").hidden = true;
}

async function saveCapturedLocation() {
  const label = el("label-input").value.trim();
  if (!label || !pending) return;

  const entry = makeLocation(
    label,
    pending.lat,
    pending.lon,
    pending.address,
    Date.now()
  );
  state.saved = addLocation(state.saved, entry);
  await saveState(state.saved, state.activeId);

  el("label-input").value = "";
  el("save-location").disabled = true;
  hideCapture();
  renderSavedList();
}

// --- geolocation --------------------------------------------------------

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject({ code: 2 });
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0,
    });
  });
}

function geoErrorMessage(error) {
  if (error && error.code === 1) return MSG.geoDenied;
  if (error && error.code === 3) return MSG.geoTimeout;
  return MSG.geoUnavailable;
}

function showStatus(id, message) {
  const node = el(id);
  node.hidden = !message;
  node.textContent = message || "";
}

async function requestLocation() {
  const button = el("get-location");
  button.disabled = true;
  showStatus("geo-status", "Getting your location…");

  try {
    const position = await getCurrentPosition();
    const lat = position.coords.latitude;
    const lon = position.coords.longitude;

    // A failed reverse lookup must not block saving: the coordinates are
    // useful on their own.
    let address = null;
    try {
      address = await reverseGeocode(lat, lon);
    } catch (err) {
      address = null;
    }

    showStatus("geo-status", address ? "" : MSG.addressUnavailable);
    showCapture({ lat, lon, address });
  } catch (error) {
    hideCapture();
    showStatus("geo-status", geoErrorMessage(error));
  } finally {
    button.disabled = false;
  }
}

// --- address suggestions ------------------------------------------------

let suggestions = [];
let highlighted = -1;
let suggestRequest = null;
let debounceTimer = null;

function activeEntryCoords() {
  const entry = state.saved.find((e) => e.id === state.activeId);
  return entry ? { lat: entry.lat, lon: entry.lon } : null;
}

function closeSuggestions() {
  suggestions = [];
  highlighted = -1;
  const list = el("address-suggestions");
  list.textContent = "";
  list.hidden = true;
  el("address-input").setAttribute("aria-expanded", "false");
}

function renderSuggestions() {
  const list = el("address-suggestions");
  const input = el("address-input");
  list.textContent = "";

  if (!suggestions.length) {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    return;
  }

  suggestions.forEach((suggestion, index) => {
    const item = document.createElement("li");
    item.className = "suggestion";
    item.id = `suggestion-${index}`;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(index === highlighted));
    if (index === highlighted) item.classList.add("is-highlighted");

    // textContent: Mapbox strings are untrusted input.
    item.textContent =
      suggestion.address || formatCoords(suggestion.lat, suggestion.lon);

    // mousedown, not click: the input's blur would close the list first.
    item.addEventListener("mousedown", (event) => {
      event.preventDefault();
      chooseSuggestion(index);
    });

    list.append(item);
  });

  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
  input.setAttribute(
    "aria-activedescendant",
    highlighted >= 0 ? `suggestion-${highlighted}` : ""
  );

  if (highlighted >= 0 && list.children[highlighted]) {
    list.children[highlighted].scrollIntoView({ block: "nearest" });
  }
}

function moveHighlight(delta) {
  if (!suggestions.length) return;
  const next = highlighted + delta;
  highlighted = Math.max(0, Math.min(suggestions.length - 1, next));
  renderSuggestions();
}

function chooseSuggestion(index) {
  const suggestion = suggestions[index];
  if (!suggestion) return;
  el("address-input").value = suggestion.address || "";
  showStatus("address-status", "");
  closeSuggestions();
  showCapture(suggestion);
}

async function fetchSuggestions(query) {
  // Cancel the previous lookup so a slow earlier response cannot overwrite
  // the results for what the user has actually typed.
  if (suggestRequest) suggestRequest.abort();
  const controller = new AbortController();
  suggestRequest = controller;

  showStatus("address-status", "Searching…");

  try {
    const results = await geocodeSuggestions(query, {
      signal: controller.signal,
      proximity: activeEntryCoords(),
    });
    if (controller.signal.aborted) return;

    suggestions = results;
    highlighted = -1;
    renderSuggestions();
    showStatus("address-status", results.length ? "" : MSG.addressNotFound);
  } catch (error) {
    if (error && error.name === "AbortError") return;
    closeSuggestions();
    showStatus(
      "address-status",
      error && error.kind === "no-token" ? MSG.noToken : MSG.addressFailed
    );
  } finally {
    if (suggestRequest === controller) suggestRequest = null;
  }
}

function onAddressInput() {
  const query = el("address-input").value.trim();
  clearTimeout(debounceTimer);

  if (query.length < MIN_QUERY_LENGTH) {
    if (suggestRequest) suggestRequest.abort();
    closeSuggestions();
    showStatus("address-status", "");
    return;
  }

  debounceTimer = setTimeout(() => fetchSuggestions(query), DEBOUNCE_MS);
}

function onAddressKeydown(event) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveHighlight(highlighted < 0 ? 1 : 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    moveHighlight(-1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    // Only an explicitly highlighted row is selectable; Enter never guesses.
    if (highlighted >= 0) chooseSuggestion(highlighted);
  } else if (event.key === "Escape") {
    closeSuggestions();
  }
}

// --- listing section ----------------------------------------------------

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

function showListingFallback(message) {
  el("details").hidden = true;
  el("fallback").hidden = false;
  el("fallback").textContent = message;
}

function renderListing(info) {
  if (info) {
    el("debug").hidden = false;
    el("debug").textContent = [
      info.build || "no build",
      `listing ${info.isListingPage ? "y" : "n"}`,
      `static map ${info.staticMapFound ? "y" : "n"}`,
    ].join(" · ");
  }

  if (!info || !info.location) {
    showListingFallback(MSG.fallback);
    return;
  }

  const { lat, lon, radiusKm } = info.location;
  el("fallback").hidden = true;
  el("details").hidden = false;
  setField("location-text", info.locationText || null);
  setField("coordinates", `${lat.toFixed(6)}, ${lon.toFixed(6)}`);
  setField("radius", formatRadius(radiusKm));
}

function loadListingInfo() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || tab.id === undefined) {
      showListingFallback(MSG.fallback);
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
          showListingFallback(onFacebook ? MSG.staleScript : MSG.fallback);
          return;
        }
        renderListing(response);
      }
    );
  });
}

// --- wiring -------------------------------------------------------------

async function main() {
  el("get-location").addEventListener("click", requestLocation);
  el("save-location").addEventListener("click", saveCapturedLocation);

  const addressInput = el("address-input");
  addressInput.addEventListener("input", onAddressInput);
  addressInput.addEventListener("keydown", onAddressKeydown);
  addressInput.addEventListener("blur", () => {
    // Let a mousedown on a row land before the list disappears.
    setTimeout(closeSuggestions, 150);
  });

  const labelInput = el("label-input");
  labelInput.addEventListener("input", () => {
    el("save-location").disabled = labelInput.value.trim().length === 0;
  });
  labelInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && labelInput.value.trim()) {
      saveCapturedLocation();
    }
  });

  state = await loadState();
  renderSavedList();
  loadListingInfo();
}

if (typeof document !== "undefined" && document.addEventListener) {
  document.addEventListener("DOMContentLoaded", () => {
    main().catch((err) => {
      showStatus(
        "geo-status",
        `Popup error: ${err && err.message ? err.message : err}`
      );
    });
  });
}

// Test hook: inert in the browser.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    normaliseSaved,
    addLocation,
    removeLocation,
    activeAfterRemoval,
    formatCoords,
    formatRadius,
    describeEntry,
    geoErrorMessage,
    coordsFromFeature,
    firstFeature,
    geocodeSuggestions,
    reverseGeocode,
    mapboxToken,
    makeLocation,
    MSG,
  };
}
