// Reads listing cards out of the rendered Marketplace feed.
// Isolated world; exposes its API on the shared window.DetourRouter global.
(function () {
  "use strict";

  const NS = (window.DetourRouter = window.DetourRouter || {});
  const LOG = "[DetourRouter]";

  const ITEM_ID_RE = /\/marketplace\/item\/(\d+)/;

  // A price line has a digit plus a currency marker, or is literally "Free".
  const CURRENCY_RE =
    /[$£€¥₩₹₱₫฿]|\b(?:USD|HKD|EUR|GBP|JPY|CNY|RMB|AUD|CAD|SGD|KRW|INR|PHP|THB|MXN|NZD|SEK|NOK|DKK|CHF|TWD|MYR|IDR|VND)\b/i;

  function looksLikePrice(line) {
    const text = (line || "").trim();
    if (!text) return false;
    if (/^free$/i.test(text)) return true;
    return /\d/.test(text) && CURRENCY_RE.test(text);
  }

  function parseLines(rawLines) {
    const empty = { price: "", title: "", location: "" };
    if (!rawLines.length) return empty;

    const priceIndex = rawLines.findIndex(looksLikePrice);
    if (priceIndex === -1) return empty;

    // A discounted card shows the old price struck through right after the
    // new one, so skip any further price-looking lines to reach the title.
    let title = "";
    for (let i = priceIndex + 1; i < rawLines.length; i += 1) {
      if (!looksLikePrice(rawLines[i])) {
        title = rawLines[i];
        break;
      }
    }
    if (!title) return empty;

    return {
      price: rawLines[priceIndex],
      title,
      location: rawLines[rawLines.length - 1],
    };
  }

  function collectAnchors() {
    // The sidebar lives in a shadow root, so its own links never match.
    return document.querySelectorAll('a[href*="/marketplace/item/"]');
  }

  // TODO: the feed is infinite-scroll. This only reads what is currently
  // rendered; sampling further down will need programmatic scrolling.
  function scrapeFeedListings() {
    const byId = new Map();

    for (const anchor of collectAnchors()) {
      const match = ITEM_ID_RE.exec(anchor.getAttribute("href") || "");
      if (!match) continue;

      const id = match[1];
      if (byId.has(id)) continue;

      const image = anchor.querySelector("img");
      const rawLines = (anchor.innerText || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      byId.set(id, {
        id,
        url: `https://www.facebook.com/marketplace/item/${id}/`,
        image: image ? image.src || "" : "",
        ...parseLines(rawLines),
        rawLines,
      });
    }

    const listings = Array.from(byId.values());
    console.log(
      `${LOG} scraped ${listings.length} listing(s); first 3:`,
      listings.slice(0, 3).map((listing) => ({
        price: listing.price,
        title: listing.title,
        location: listing.location,
        rawLines: listing.rawLines,
      }))
    );
    return listings;
  }

  // Quiet variant for polling: scrapeFeedListings() logs on every call, and
  // step H checks this several times a second.
  function snapshotListingIds(limit) {
    const ids = [];
    const seen = new Set();
    for (const anchor of collectAnchors()) {
      const match = ITEM_ID_RE.exec(anchor.getAttribute("href") || "");
      if (!match || seen.has(match[1])) continue;
      seen.add(match[1]);
      ids.push(match[1]);
      if (ids.length >= (limit || 5)) break;
    }
    return ids;
  }

  NS.scrapeFeedListings = scrapeFeedListings;
  NS.snapshotListingIds = snapshotListingIds;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { scrapeFeedListings, snapshotListingIds, looksLikePrice, parseLines };
  }
})();
