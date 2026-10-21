console.log(
  "Marketplace Detour Router: content script active on " + window.location.href
);

(function showActiveBanner() {
  const BANNER_ID = "mdr-active-banner";
  if (document.getElementById(BANNER_ID)) return;

  const banner = document.createElement("div");
  banner.id = BANNER_ID;
  banner.textContent = "Detour Router Active";
  banner.title = "Click to dismiss";

  Object.assign(banner.style, {
    position: "fixed",
    bottom: "12px",
    right: "12px",
    zIndex: "2147483647",
    padding: "6px 10px",
    borderRadius: "6px",
    background: "#1877f2",
    color: "#ffffff",
    font: "500 12px/1.2 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    boxShadow: "0 1px 4px rgba(0, 0, 0, 0.3)",
    opacity: "0.45",
    cursor: "pointer",
    transition: "opacity 0.2s ease",
    pointerEvents: "auto",
  });

  banner.addEventListener("mouseenter", () => (banner.style.opacity = "1"));
  banner.addEventListener("mouseleave", () => (banner.style.opacity = "0.45"));
  banner.addEventListener("click", () => banner.remove());

  document.body.appendChild(banner);
})();

(function mdrListingLocation() {
  "use strict";

  // Bump on every change. The popup shows this, so a stale content script
  // (extension reloaded but the tab never refreshed) is obvious at a glance.
  const BUILD = "build-7";

  const LISTING_PATH_RE = /\/marketplace\/item\//;
  const LISTING_ID_RE = /\/marketplace\/item\/(\d+)/;
  const URL_IN_CSS_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/i;

  // --- step 2: reading the URL out of the CSS value ----------------------

  // getAttribute('style') and outerHTML give entity-escaped text; the live
  // style object does not. Normalise so both paths parse the same.
  function decodeEntities(value) {
    return value
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }

  function urlFromCssValue(value) {
    if (!value || value.indexOf("static_map") === -1) return null;
    const match = URL_IN_CSS_RE.exec(value);
    if (!match) return null;
    const url = decodeEntities(match[2]).trim();
    return url.indexOf("static_map") === -1 ? null : url;
  }

  // --- step 1: finding the element ---------------------------------------

  function staticMapUrlFrom(element) {
    const candidates = [];
    if (element.style) {
      candidates.push(element.style.getPropertyValue("--x-backgroundImage"));
      candidates.push(element.style.backgroundImage);
    }
    candidates.push(element.getAttribute("style") || "");

    for (const candidate of candidates) {
      const url = urlFromCssValue(candidate);
      if (url) return url;
    }
    return null;
  }

  function findStaticMapUrl() {
    const groups = [
      document.querySelectorAll('[style*="static_map"]'),
      document.querySelectorAll('[style*="--x-backgroundImage"]'),
    ];
    for (const group of groups) {
      for (const element of group) {
        const url = staticMapUrlFrom(element);
        if (url) return url;
      }
    }
    return null;
  }

  // --- steps 3 & 4: parsing the query string -----------------------------

  function plausibleCoords(lat, lon) {
    return (
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      lat >= -90 &&
      lat <= 90 &&
      lon >= -180 &&
      lon <= 180 &&
      !(lat === 0 && lon === 0)
    );
  }

  function parseLatLonPair(value) {
    if (!value) return null;
    const parts = value.split(",");
    if (parts.length !== 2) return null;
    const lat = Number(parts[0]);
    const lon = Number(parts[1]);
    return plausibleCoords(lat, lon) ? { lat, lon } : null;
  }

  // The circle's last segment is the radius: "2k" means 2km.
  function parseRadiusKm(segment) {
    if (!segment) return null;
    const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(segment.trim());
    if (!match) return null;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) return null;
    return match[2].toLowerCase() === "m" ? value / 1000 : value;
  }

  function parseStaticMapUrl(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl, window.location.href);
    } catch (err) {
      return null;
    }

    const circleParts = (url.searchParams.get("circle") || "")
      .split("|")
      .map((part) => part.trim())
      .filter(Boolean);

    // weight:...|color:...|fillcolor:...|lat,lon|radius
    const radiusKm =
      circleParts.length > 0
        ? parseRadiusKm(circleParts[circleParts.length - 1])
        : null;

    // Prefer "center"; the circle carries the same pair as a fallback.
    const center =
      parseLatLonPair(url.searchParams.get("center")) ||
      (circleParts.length > 1
        ? parseLatLonPair(circleParts[circleParts.length - 2])
        : null);

    if (!center) return null;
    return { lat: center.lat, lon: center.lon, radiusKm };
  }

  // --- step 5 ------------------------------------------------------------

  function extractListingLocation() {
    const rawUrl = findStaticMapUrl();
    if (!rawUrl) return null;
    return parseStaticMapUrl(rawUrl);
  }

  // --- location text ------------------------------------------------------
  // Facebook renders "<place> · Location is approximate" under the map, so
  // find that caption and strip it to leave the place name. Works for
  // "Columbia, MO" and "New Territories, Hong Kong SAR" alike.

  const APPROX_RE = /location is approximate/i;

  function findApproximateCaption() {
    if (typeof document.createTreeWalker !== "function") return null;
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null
    );
    let seen = 0;
    while (walker.nextNode() && seen < 8000) {
      seen += 1;
      if (APPROX_RE.test(walker.currentNode.nodeValue || "")) {
        return walker.currentNode.parentElement;
      }
    }
    return null;
  }

  function extractLocationText() {
    try {
      let node = findApproximateCaption();
      // Climb until the container also holds the place name, not just the
      // caption itself.
      for (let depth = 0; depth < 4 && node; depth += 1) {
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        const stripped = text
          .replace(APPROX_RE, "")
          .replace(/[·•|,\s]+$/, "")
          .replace(/^[·•|,\s]+/, "")
          .trim();
        if (stripped.length > 1 && stripped.length <= 80) return stripped;
        node = node.parentElement;
      }
    } catch (err) {
      /* fall through */
    }
    return null;
  }

  // --- step 6: message passing --------------------------------------------

  function getListingInfo() {
    return {
      build: BUILD,
      url: window.location.href,
      isListingPage: LISTING_PATH_RE.test(window.location.pathname),
      // Keys any user-supplied exact address to this specific listing.
      listingId: (LISTING_ID_RE.exec(window.location.pathname) || [])[1] || null,
      staticMapFound: !!findStaticMapUrl(),
      locationText: extractLocationText(),
      location: extractListingLocation(),
    };
  }

  if (
    typeof chrome !== "undefined" &&
    chrome.runtime &&
    chrome.runtime.onMessage
  ) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.type !== "MDR_GET_LISTING_INFO") return false;
      try {
        sendResponse(getListingInfo());
      } catch (err) {
        sendResponse({ build: BUILD, error: String(err) });
      }
      return false;
    });
  }

  // Callable from DevTools: pick this extension's context in the console's
  // JS-context dropdown, then run mdrDebug().
  if (typeof window !== "undefined") {
    window.mdrDebug = getListingInfo;

    // Shared with the other isolated-world scripts so location-modal.js can
    // reuse this static_map.php parsing instead of duplicating it.
    const NS = (window.DetourRouter = window.DetourRouter || {});
    NS.staticMapUrlFrom = staticMapUrlFrom;
    NS.parseStaticMapUrl = parseStaticMapUrl;
    NS.extractListingLocation = extractListingLocation;
  }

  // Test hook: `module` is undefined in a content script, so this is inert in
  // the browser and lets the URL parsing be exercised from Node.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      extractListingLocation,
      parseStaticMapUrl,
      urlFromCssValue,
      parseRadiusKm,
      getListingInfo,
    };
  }
})();
