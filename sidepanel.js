const MSG = {
  fallback: "Open a listing to see its location.",
  geoDenied:
    "Location access denied — you can still manage saved locations below.",
  geoUnavailable:
    "Couldn't determine your location — you can still manage saved locations below.",
  geoTimeout:
    "Timed out getting your location — you can still manage saved locations below.",
  addressNotFound: "Couldn't find that address — try being more specific.",
  addressFailed:
    "Address lookup failed — check your connection and try again.",
  noToken: "Paste your Mapbox token into config.js to use the map.",
  addressUnavailable: "Address unavailable",
  noOrigins: "Save a location below to use as a starting point.",
  noListing: "Open a Marketplace listing to route to it.",
  noRoutes: "No driving route found between these two points.",
  routeFailed: "Couldn't load routes — check your connection.",
  approximate: "Approximate area",
  exact: "Exact address",
  mapFailed: "The map couldn't be drawn — see the panel console.",
};

const STORAGE_KEYS = {
  saved: "savedLocations",
  active: "activeLocationId",
  overrides: "listingOverrides",
};

const MAPBOX_GEOCODE = "https://api.mapbox.com/geocoding/v5/mapbox.places";
const MAPBOX_DIRECTIONS = "https://api.mapbox.com/directions/v5/mapbox/driving";
const MAPBOX_TILES =
  "https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/{z}/{x}/{y}@2x";
const PLACEHOLDER_TOKEN = "PASTE_MAPBOX_TOKEN_HERE";
const GEOCODE_TIMEOUT_MS = 8000;
const ROUTE_TIMEOUT_MS = 10000;
const SUGGESTION_LIMIT = 5;
const MIN_QUERY_LENGTH = 3;
const DEBOUNCE_MS = 300;

// --- pure helpers (exercised by the Node tests) -------------------------

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

// { [listingId]: { lat, lon, address, setAt } }
function normaliseOverrides(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object") continue;
    const lat = Number(entry.lat);
    const lon = Number(entry.lon);
    if (!plausibleCoords(lat, lon)) continue;
    out[id] = {
      lat,
      lon,
      address: typeof entry.address === "string" ? entry.address : null,
      setAt: Number.isFinite(entry.setAt) ? entry.setAt : 0,
    };
  }
  return out;
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

function addLocation(saved, entry) {
  return saved.concat([entry]);
}

function removeLocation(saved, id) {
  return saved.filter((entry) => entry.id !== id);
}

function activeAfterRemoval(activeId, removedId) {
  return activeId === removedId ? null : activeId;
}

function formatCoords(lat, lon) {
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

function describeEntry(entry) {
  return `${entry.label} — ${entry.address || MSG.addressUnavailable}`;
}

function formatRadius(radiusKm) {
  if (typeof radiusKm !== "number" || !(radiusKm > 0)) return null;
  const rounded = radiusKm % 1 === 0 ? radiusKm : Number(radiusKm.toFixed(2));
  return `${rounded} km`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return "< 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

function formatDistance(meters) {
  if (!Number.isFinite(meters) || meters < 0) return null;
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

// The point routes are drawn to: a user-confirmed address when one exists,
// otherwise the centre of Facebook's fuzz circle -- which is NOT where the
// item is, only the middle of the area it might be in.
function resolveDestination(listing, override) {
  if (!listing) return null;
  if (override && plausibleCoords(override.lat, override.lon)) {
    return {
      lat: override.lat,
      lon: override.lon,
      exact: true,
      address: override.address || null,
    };
  }
  if (!plausibleCoords(listing.approxLat, listing.approxLon)) return null;
  return {
    lat: listing.approxLat,
    lon: listing.approxLon,
    exact: false,
    address: listing.label || null,
  };
}

// GeoJSON is [lon, lat]; Leaflet wants [lat, lon]. One place for the swap.
function toLatLngs(geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return [];
  return geometry.coordinates
    .filter((pair) => Array.isArray(pair) && pair.length >= 2)
    .map((pair) => [Number(pair[1]), Number(pair[0])])
    .filter(([lat, lon]) => plausibleCoords(lat, lon));
}

function parseRoutes(payload) {
  if (!payload || !Array.isArray(payload.routes)) return [];
  return payload.routes
    .map((route, index) => ({
      index,
      duration: Number(route.duration),
      distance: Number(route.distance),
      latLngs: toLatLngs(route.geometry),
      summary: (route.legs && route.legs[0] && route.legs[0].summary) || "",
    }))
    .filter(
      (route) =>
        Number.isFinite(route.duration) &&
        Number.isFinite(route.distance) &&
        route.latLngs.length > 1
    );
}

// Mapbox wants lon,lat in the path -- reversed from lat/lon used elsewhere.
function buildDirectionsUrl(origin, destination, token) {
  const coords = `${origin.lon},${origin.lat};${destination.lon},${destination.lat}`;
  const params = new URLSearchParams({
    alternatives: "true",
    geometries: "geojson",
    overview: "full",
    steps: "false",
    access_token: token,
  });
  return `${MAPBOX_DIRECTIONS}/${coords}?${params.toString()}`;
}

function coordsFromFeature(feature) {
  if (!feature) return null;
  const pair = Array.isArray(feature.center)
    ? feature.center
    : feature.geometry && Array.isArray(feature.geometry.coordinates)
      ? feature.geometry.coordinates
      : null;
  if (!pair || pair.length < 2) return null;

  // Mapbox returns [longitude, latitude].
  const lon = Number(pair[0]);
  const lat = Number(pair[1]);
  return plausibleCoords(lat, lon) ? { lat, lon } : null;
}

function firstFeature(payload) {
  return payload && Array.isArray(payload.features) && payload.features.length
    ? payload.features[0]
    : null;
}

function geoErrorMessage(error) {
  if (error && error.code === 1) return MSG.geoDenied;
  if (error && error.code === 3) return MSG.geoTimeout;
  return MSG.geoUnavailable;
}

// --- Mapbox requests ----------------------------------------------------

// MAPBOX_TOKEN is a global from config.js, which is gitignored and may be
// missing on a fresh clone.
function mapboxToken() {
  if (typeof MAPBOX_TOKEN === "undefined") return null;
  const token = String(MAPBOX_TOKEN).trim();
  if (!token || token === PLACEHOLDER_TOKEN) return null;
  return token;
}

function tokenError() {
  const err = new Error(MSG.noToken);
  err.kind = "no-token";
  return err;
}

async function fetchJson(url, timeoutMs, externalSignal) {
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

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

async function geocodeSuggestions(query, options) {
  const token = mapboxToken();
  if (!token) throw tokenError();

  const opts = options || {};
  const params = new URLSearchParams({
    access_token: token,
    limit: String(SUGGESTION_LIMIT),
    autocomplete: "true",
  });
  if (opts.proximity && plausibleCoords(opts.proximity.lat, opts.proximity.lon)) {
    params.set("proximity", `${opts.proximity.lon},${opts.proximity.lat}`);
  }

  const url = `${MAPBOX_GEOCODE}/${encodeURIComponent(query)}.json?${params.toString()}`;
  const payload = await fetchJson(url, GEOCODE_TIMEOUT_MS, opts.signal);

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

// Note the lon,lat order in the path.
async function reverseGeocode(lat, lon) {
  const token = mapboxToken();
  if (!token) throw tokenError();
  const params = new URLSearchParams({ access_token: token, limit: "1" });
  const url = `${MAPBOX_GEOCODE}/${lon},${lat}.json?${params.toString()}`;
  const feature = firstFeature(await fetchJson(url, GEOCODE_TIMEOUT_MS));
  return feature && feature.place_name ? feature.place_name : null;
}

async function fetchRoutes(origin, destination, signal) {
  const token = mapboxToken();
  if (!token) throw tokenError();
  const payload = await fetchJson(
    buildDirectionsUrl(origin, destination, token),
    ROUTE_TIMEOUT_MS,
    signal
  );
  return parseRoutes(payload);
}

// --- storage ------------------------------------------------------------

async function loadState() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.saved,
    STORAGE_KEYS.active,
    STORAGE_KEYS.overrides,
  ]);
  const saved = normaliseSaved(data[STORAGE_KEYS.saved]);
  const rawActive = data[STORAGE_KEYS.active];
  const activeId =
    typeof rawActive === "string" && saved.some((e) => e.id === rawActive)
      ? rawActive
      : null;
  return {
    saved,
    activeId,
    overrides: normaliseOverrides(data[STORAGE_KEYS.overrides]),
  };
}

async function saveLocations() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.saved]: state.saved,
    [STORAGE_KEYS.active]: state.activeId,
  });
}

async function saveOverrides() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.overrides]: state.overrides,
  });
}

// --- DOM ----------------------------------------------------------------

function el(id) {
  return document.getElementById(id);
}

let state = { saved: [], activeId: null, overrides: {} };
let pending = null;
let listing = null;
let routes = [];
let selectedRoute = 0;
let routeRequest = null;

function showStatus(id, message) {
  const node = el(id);
  node.hidden = !message;
  node.textContent = message || "";
}

function setField(id, value) {
  const node = el(id);
  node.textContent = value === null ? "Not found" : value;
  node.classList.toggle("missing", value === null);
}

function currentOverride() {
  if (!listing || !listing.id) return null;
  return state.overrides[listing.id] || null;
}

function currentDestination() {
  return resolveDestination(listing, currentOverride());
}

// --- reusable address search --------------------------------------------
// Used twice: for saving a location, and for setting a listing's exact
// address. Each instance owns its own debounce, abort controller and
// highlight index.

function createAddressSearch({ inputId, listId, statusId, onSelect }) {
  let items = [];
  let highlighted = -1;
  let request = null;
  let timer = null;

  function close() {
    items = [];
    highlighted = -1;
    const list = el(listId);
    list.textContent = "";
    list.hidden = true;
    el(inputId).setAttribute("aria-expanded", "false");
  }

  function render() {
    const list = el(listId);
    const input = el(inputId);
    list.textContent = "";

    if (!items.length) {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      return;
    }

    items.forEach((item, index) => {
      const row = document.createElement("li");
      row.className = "suggestion";
      row.id = `${listId}-${index}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === highlighted));
      if (index === highlighted) row.classList.add("is-highlighted");

      // textContent: Mapbox strings are untrusted input.
      row.textContent = item.address || formatCoords(item.lat, item.lon);

      // mousedown, not click: the input's blur would close the list first.
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        choose(index);
      });

      list.append(row);
    });

    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    input.setAttribute(
      "aria-activedescendant",
      highlighted >= 0 ? `${listId}-${highlighted}` : ""
    );

    if (highlighted >= 0 && list.children[highlighted]) {
      list.children[highlighted].scrollIntoView({ block: "nearest" });
    }
  }

  function move(delta) {
    if (!items.length) return;
    highlighted = Math.max(0, Math.min(items.length - 1, highlighted + delta));
    render();
  }

  function choose(index) {
    const item = items[index];
    if (!item) return;
    close();
    showStatus(statusId, "");
    onSelect(item);
  }

  async function search(query) {
    // Cancel the previous lookup so a slow earlier response cannot
    // overwrite results for what the user has actually typed.
    if (request) request.abort();
    const controller = new AbortController();
    request = controller;

    showStatus(statusId, "Searching…");

    try {
      const results = await geocodeSuggestions(query, {
        signal: controller.signal,
        proximity: proximityHint(),
      });
      if (controller.signal.aborted) return;

      items = results;
      highlighted = -1;
      render();
      showStatus(statusId, results.length ? "" : MSG.addressNotFound);
    } catch (error) {
      if (error && error.name === "AbortError") return;
      close();
      showStatus(
        statusId,
        error && error.kind === "no-token" ? MSG.noToken : MSG.addressFailed
      );
    } finally {
      if (request === controller) request = null;
    }
  }

  const input = el(inputId);

  input.addEventListener("input", () => {
    const query = input.value.trim();
    clearTimeout(timer);
    if (query.length < MIN_QUERY_LENGTH) {
      if (request) request.abort();
      close();
      showStatus(statusId, "");
      return;
    }
    timer = setTimeout(() => search(query), DEBOUNCE_MS);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      // Only an explicitly highlighted row is selectable; Enter never guesses.
      if (highlighted >= 0) choose(highlighted);
    } else if (event.key === "Escape") {
      close();
    }
  });

  input.addEventListener("blur", () => setTimeout(close, 150));

  return { close };
}

// Bias results toward the listing if we have one, else the active location.
function proximityHint() {
  const destination = currentDestination();
  if (destination) return { lat: destination.lat, lon: destination.lon };
  const entry = state.saved.find((e) => e.id === state.activeId);
  return entry ? { lat: entry.lat, lon: entry.lon } : null;
}

// --- map ----------------------------------------------------------------

let map = null;
let routeLayers = [];
let markerLayers = [];

function ensureMap() {
  if (map) return map;
  const token = mapboxToken();
  if (!token || typeof L === "undefined") return null;

  map = L.map("map", { zoomControl: true }).setView([39.5, -98.35], 3);

  L.tileLayer(`${MAPBOX_TILES}?access_token=${token}`, {
    tileSize: 512,
    zoomOffset: -1,
    maxZoom: 20,
    attribution:
      '© <a href="https://www.mapbox.com/about/maps/">Mapbox</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  // The side panel is user-resizable, so the map must be told when its
  // container changes size or it renders into stale dimensions.
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => map.invalidateSize()).observe(el("map"));
  }

  return map;
}

function pinIcon(text, className) {
  return L.divIcon({
    className: `pin ${className}`,
    html: `<span>${text}</span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function clearLayers(list) {
  for (const layer of list) layer.remove();
  list.length = 0;
}

// The circle is the honest picture of an unconfirmed listing: the item is
// somewhere inside it, not at its centre. A confirmed address replaces that
// with a single exact pin, keeping the old circle faint for comparison.
function drawListingMarkers(instance) {
  clearLayers(markerLayers);
  if (!listing) return;

  const destination = currentDestination();
  if (!destination) return;

  const hasCircle =
    Number.isFinite(listing.radiusKm) &&
    listing.radiusKm > 0 &&
    plausibleCoords(listing.approxLat, listing.approxLon);

  if (hasCircle) {
    markerLayers.push(
      L.circle([listing.approxLat, listing.approxLon], {
        radius: listing.radiusKm * 1000,
        color: destination.exact ? "#9aa0a6" : "#e74c3c",
        weight: destination.exact ? 1 : 2,
        opacity: destination.exact ? 0.45 : 0.9,
        fillColor: destination.exact ? "#9aa0a6" : "#e74c3c",
        fillOpacity: destination.exact ? 0.04 : 0.1,
        dashArray: "6 5",
      }).addTo(instance)
    );
  }

  // With an exact address set, show where Facebook claimed it was too, so
  // the gap between the two is visible.
  if (destination.exact && plausibleCoords(listing.approxLat, listing.approxLon)) {
    markerLayers.push(
      L.circleMarker([listing.approxLat, listing.approxLon], {
        radius: 4,
        color: "#9aa0a6",
        weight: 1,
        fillColor: "#9aa0a6",
        fillOpacity: 0.8,
      })
        .bindTooltip("Facebook's approximate centre")
        .addTo(instance)
    );
  }

  markerLayers.push(
    L.marker([destination.lat, destination.lon], {
      icon: pinIcon("B", destination.exact ? "pin-b" : "pin-b pin-approx"),
    })
      .bindTooltip(destination.exact ? MSG.exact : MSG.approximate)
      .addTo(instance)
  );

  const origin = currentOrigin();
  if (origin) {
    markerLayers.push(
      L.marker([origin.lat, origin.lon], { icon: pinIcon("A", "pin-a") })
        .bindTooltip(origin.label)
        .addTo(instance)
    );
  }
}

function fitToContent(instance) {
  const chosen = routes[selectedRoute];
  if (chosen && chosen.latLngs.length > 1) {
    instance.fitBounds(L.latLngBounds(chosen.latLngs), { padding: [24, 24] });
    return;
  }

  // No route yet: frame the listing and its circle.
  const destination = currentDestination();
  if (!destination) return;

  if (
    Number.isFinite(listing.radiusKm) &&
    listing.radiusKm > 0 &&
    plausibleCoords(listing.approxLat, listing.approxLon)
  ) {
    // LatLng.toBounds() is map-independent. Circle.getBounds() is NOT: it
    // calls this._map.layerPointToLatLng(), which throws on a layer that was
    // never added to a map.
    instance.fitBounds(
      L.latLng(listing.approxLat, listing.approxLon).toBounds(
        listing.radiusKm * 2000
      ),
      { padding: [24, 24] }
    );
  } else {
    instance.setView([destination.lat, destination.lon], 14);
  }
}

function drawMap() {
  // A rendering failure must not take the rest of the panel with it; the
  // listing details and saved locations stay usable without a map.
  try {
    drawMapUnsafe();
  } catch (error) {
    console.error("Map render failed", error);
    showStatus("route-status", MSG.mapFailed);
  }
}

function drawMapUnsafe() {
  const instance = ensureMap();
  if (!instance) return;

  clearLayers(routeLayers);

  // Unselected first so the selected route draws on top of them.
  routes.forEach((route, index) => {
    if (index === selectedRoute) return;
    const line = L.polyline(route.latLngs, {
      color: "#9aa0a6",
      weight: 4,
      opacity: 0.7,
    }).addTo(instance);
    line.on("click", () => selectRoute(index));
    routeLayers.push(line);
  });

  const chosen = routes[selectedRoute];
  if (chosen) {
    routeLayers.push(
      L.polyline(chosen.latLngs, {
        color: "#1877f2",
        weight: 6,
        opacity: 0.95,
      }).addTo(instance)
    );
  }

  drawListingMarkers(instance);
  fitToContent(instance);
}

function updateMapVisibility() {
  const usable = !!mapboxToken() && !!currentDestination();
  el("map").hidden = !usable;
  el("map-placeholder").hidden = usable;
  if (usable) {
    const instance = ensureMap();
    if (instance) setTimeout(() => instance.invalidateSize(), 0);
  }
}

// --- routes -------------------------------------------------------------

function currentOrigin() {
  const select = el("origin-select");
  return state.saved.find((entry) => entry.id === select.value) || null;
}

function selectRoute(index) {
  selectedRoute = index;
  renderRouteList();
  drawMap();
}

function renderRouteList() {
  const list = el("route-list");
  list.textContent = "";

  routes.forEach((route, index) => {
    const item = document.createElement("li");
    item.className = "route-row";
    if (index === selectedRoute) item.classList.add("is-selected");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "route-button";
    button.setAttribute("aria-pressed", String(index === selectedRoute));

    const time = document.createElement("span");
    time.className = "route-time";
    time.textContent = formatDuration(route.duration) || "—";

    const detail = document.createElement("span");
    detail.className = "route-detail";
    const distance = formatDistance(route.distance) || "—";
    // textContent: summaries are road names from an external API.
    detail.textContent = route.summary
      ? `${distance} · via ${route.summary}`
      : distance;

    button.append(time, detail);
    button.addEventListener("click", () => selectRoute(index));
    item.append(button);
    list.append(item);
  });
}

async function refreshRoutes() {
  const origin = currentOrigin();
  const destination = currentDestination();

  routes = [];
  selectedRoute = 0;
  renderRouteList();
  updateMapVisibility();
  drawMap();

  if (!destination) {
    showStatus("route-status", MSG.noListing);
    return;
  }
  if (!state.saved.length) {
    showStatus("route-status", MSG.noOrigins);
    return;
  }
  if (!origin) return;

  if (routeRequest) routeRequest.abort();
  const controller = new AbortController();
  routeRequest = controller;

  showStatus("route-status", "Finding routes…");

  try {
    const found = await fetchRoutes(origin, destination, controller.signal);
    if (controller.signal.aborted) return;
    routes = found;
    showStatus("route-status", found.length ? "" : MSG.noRoutes);
  } catch (error) {
    if (error && error.name === "AbortError") return;
    routes = [];
    showStatus(
      "route-status",
      error && error.kind === "no-token" ? MSG.noToken : MSG.routeFailed
    );
  } finally {
    if (routeRequest === controller) routeRequest = null;
  }

  renderRouteList();
  drawMap();
}

function populateOrigins() {
  const select = el("origin-select");
  const previous = select.value;
  select.textContent = "";

  for (const entry of state.saved) {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = describeEntry(entry);
    select.append(option);
  }

  const wanted = state.saved.some((e) => e.id === previous)
    ? previous
    : state.activeId;
  if (wanted && state.saved.some((e) => e.id === wanted)) {
    select.value = wanted;
  }
  select.disabled = state.saved.length === 0;
}

// --- confirmed address --------------------------------------------------

async function setConfirmedAddress(item) {
  if (!listing || !listing.id) return;
  state.overrides[listing.id] = {
    lat: item.lat,
    lon: item.lon,
    address: item.address || null,
    setAt: Date.now(),
  };
  await saveOverrides();
  el("confirm-input").value = "";
  renderConfirmed();
  await refreshRoutes();
}

async function clearConfirmedAddress() {
  if (!listing || !listing.id) return;
  delete state.overrides[listing.id];
  await saveOverrides();
  renderConfirmed();
  await refreshRoutes();
}

function renderConfirmed() {
  const block = el("confirm-block");
  const banner = el("confirmed-banner");

  // Without a listing id there is nothing to key an override to.
  if (!listing || !listing.id) {
    block.hidden = true;
    banner.hidden = true;
    return;
  }

  block.hidden = false;
  const override = currentOverride();

  if (override) {
    banner.hidden = false;
    el("confirmed-text").textContent =
      override.address || formatCoords(override.lat, override.lon);
  } else {
    banner.hidden = true;
  }

  const destination = currentDestination();
  setField(
    "routing-to",
    destination
      ? destination.exact
        ? `${MSG.exact}✓`
        : `${MSG.approximate} (centre)`
      : null
  );
}

// --- saved locations ----------------------------------------------------

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

    // textContent throughout: labels and addresses are untrusted input.
    const primary = document.createElement("span");
    primary.className = "saved-name";
    primary.textContent = describeEntry(entry);

    const coords = document.createElement("span");
    coords.className = "saved-coords";
    coords.textContent = formatCoords(entry.lat, entry.lon);

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
  await saveLocations();
  renderSavedList();
}

async function deleteLocation(id) {
  const wasOrigin = el("origin-select").value === id;
  state.saved = removeLocation(state.saved, id);
  state.activeId = activeAfterRemoval(state.activeId, id);
  await saveLocations();
  renderSavedList();
  populateOrigins();
  if (wasOrigin) await refreshRoutes();
}

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
  if (!state.activeId) state.activeId = entry.id;
  await saveLocations();

  el("label-input").value = "";
  el("address-input").value = "";
  el("save-location").disabled = true;
  hideCapture();
  renderSavedList();
  populateOrigins();
  await refreshRoutes();
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

async function requestLocation() {
  const button = el("get-location");
  button.disabled = true;
  showStatus("geo-status", "Getting your location…");

  try {
    const position = await getCurrentPosition();
    const lat = position.coords.latitude;
    const lon = position.coords.longitude;

    // A failed reverse lookup must not block saving.
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

// --- listing ------------------------------------------------------------

function renderListing(info) {
  if (info) {
    el("debug").hidden = false;
    el("debug").textContent = [
      info.build || "no build",
      `listing ${info.isListingPage ? "y" : "n"}`,
      `static map ${info.staticMapFound ? "y" : "n"}`,
      `id ${info.listingId || "none"}`,
    ].join(" · ");
  }

  if (!info || !info.location) {
    el("details").hidden = true;
    el("fallback").hidden = false;
    el("fallback").textContent = MSG.fallback;
    listing = null;
    renderConfirmed();
    return;
  }

  const { lat, lon, radiusKm } = info.location;
  el("fallback").hidden = true;
  el("details").hidden = false;
  setField("location-text", info.locationText || null);
  setField("coordinates", `${lat.toFixed(6)}, ${lon.toFixed(6)}`);
  setField("radius", formatRadius(radiusKm));

  listing = {
    id: info.listingId || null,
    approxLat: lat,
    approxLon: lon,
    radiusKm: typeof radiusKm === "number" ? radiusKm : null,
    label: info.locationText || null,
  };
  renderConfirmed();
}

function askActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || tab.id === undefined) {
        resolve(null);
        return;
      }
      chrome.tabs.sendMessage(
        tab.id,
        { type: "MDR_GET_LISTING_INFO" },
        (response) => {
          resolve(chrome.runtime.lastError ? null : response);
        }
      );
    });
  });
}

function destinationKey() {
  const destination = currentDestination();
  return destination ? `${destination.lat},${destination.lon}` : null;
}

// The panel stays open while browsing, so re-read whenever the tab changes.
async function refreshListing() {
  const previous = destinationKey();
  renderListing(await askActiveTab());
  if (destinationKey() !== previous) {
    updateMapVisibility();
    await refreshRoutes();
  }
}

// --- wiring -------------------------------------------------------------

async function main() {
  el("get-location").addEventListener("click", requestLocation);
  el("save-location").addEventListener("click", saveCapturedLocation);
  el("origin-select").addEventListener("change", refreshRoutes);
  el("clear-confirmed").addEventListener("click", clearConfirmedAddress);

  createAddressSearch({
    inputId: "address-input",
    listId: "address-suggestions",
    statusId: "address-status",
    onSelect: (item) => {
      el("address-input").value = item.address || "";
      showCapture(item);
    },
  });

  createAddressSearch({
    inputId: "confirm-input",
    listId: "confirm-suggestions",
    statusId: "confirm-status",
    onSelect: setConfirmedAddress,
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
  populateOrigins();

  chrome.tabs.onActivated.addListener(() => refreshListing());
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab && tab.active) {
      refreshListing();
    }
  });

  await refreshListing();
}

if (typeof document !== "undefined" && document.addEventListener) {
  document.addEventListener("DOMContentLoaded", () => {
    main().catch((err) => {
      showStatus(
        "route-status",
        `Panel error: ${err && err.message ? err.message : err}`
      );
    });
  });
}

// Test hook: inert in the browser.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    normaliseSaved,
    normaliseOverrides,
    resolveDestination,
    addLocation,
    removeLocation,
    activeAfterRemoval,
    formatCoords,
    formatRadius,
    formatDuration,
    formatDistance,
    describeEntry,
    geoErrorMessage,
    coordsFromFeature,
    firstFeature,
    toLatLngs,
    parseRoutes,
    buildDirectionsUrl,
    geocodeSuggestions,
    reverseGeocode,
    fetchRoutes,
    mapboxToken,
    makeLocation,
    MSG,
  };
}
