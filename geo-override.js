// MAIN world, document_start, every www.facebook.com page.
//
// It does NOTHING unless this tab has been marked as a worker tab. The mark
// arrives once, as a #detour-geo=<lat>,<lon> hash on the URL the background
// opens, and is immediately moved into sessionStorage -- which is per-tab,
// so it survives Facebook's own redirects and reloads inside the worker tab
// and is invisible to every other tab.
//
// document_start matters: Facebook can capture a reference to the real
// Geolocation methods early, and executeScript after load was landing too
// late to be reliable.
(function () {
  "use strict";

  const STORAGE_KEY = "detourGeo";
  const MARKER_RE = /detour-geo=(-?\d+\.?\d*),(-?\d+\.?\d*)/;

  function readMarkerFromHash() {
    const match = MARKER_RE.exec(window.location.hash || "");
    if (!match) return null;
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  }

  function remember(coords) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(coords));
    } catch (error) {
      // Storage can be blocked; the in-memory value still covers this load.
    }
  }

  function recall() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Number.isFinite(parsed.lat) || !Number.isFinite(parsed.lon)) {
        return null;
      }
      return { lat: parsed.lat, lon: parsed.lon };
    } catch (error) {
      return null;
    }
  }

  let coords = readMarkerFromHash();
  if (coords) {
    remember(coords);
    // Drop the marker so it never ends up in a shared link or in Facebook's
    // own routing.
    try {
      history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search
      );
    } catch (error) {
      /* non-fatal: the coords are already stored */
    }
  } else {
    coords = recall();
  }

  // The normal-tab case: no marker, no stored coords, touch nothing.
  if (!coords) return;

  function fakePosition() {
    return {
      coords: {
        latitude: coords.lat,
        longitude: coords.lon,
        accuracy: 10,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      },
      timestamp: Date.now(),
    };
  }

  let nextWatchId = 1;

  function getCurrentPosition(onSuccess) {
    if (typeof onSuccess === "function") {
      setTimeout(() => onSuccess(fakePosition()), 0);
    }
  }

  function watchPosition(onSuccess) {
    if (typeof onSuccess === "function") {
      setTimeout(() => onSuccess(fakePosition()), 0);
    }
    return nextWatchId++;
  }

  function clearWatch() {}

  // Patch the prototype as well as the instance: page code that grabs
  // Geolocation.prototype.getCurrentPosition would otherwise reach past an
  // instance-only patch to the real implementation.
  const targets = [];
  if (navigator.geolocation) targets.push(navigator.geolocation);
  if (typeof Geolocation === "function" && Geolocation.prototype) {
    targets.push(Geolocation.prototype);
  }
  for (const target of targets) {
    try {
      target.getCurrentPosition = getCurrentPosition;
      target.watchPosition = watchPosition;
      target.clearWatch = clearWatch;
    } catch (error) {
      /* frozen; the other target may still take */
    }
  }

  console.log("[DetourRouter][geo] override active", coords.lat, coords.lon);
})();
