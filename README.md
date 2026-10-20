# fb-marketplace-detour

Chrome extension (Manifest V3) scaffold for **Marketplace Detour Router**.

Current state: no routing logic yet. The extension loads, proves it is running on
Facebook pages, and reads a Marketplace listing's approximate coordinates and
radius out of its static map image URL.

## Load unpacked in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle, top right)
3. Click **Load unpacked**
4. Select this folder (the repo root, containing `manifest.json`)

## What to expect when testing

- **No errors** on the extension card in `chrome://extensions`.
- **Service worker:** click "service worker" on the extension card to open its
  console. On install/reload you should see `Marketplace Detour Router installed`.
- **Popup:** click the toolbar icon. On a listing page you should see three
  labelled lines:

  ```
  Listing location   Columbia, MO
  Coordinates        38.883362, -92.246704
  Approx. radius     2 km
  ```

  Anywhere else it falls back to "Open a listing to see its location."
- **Content script:** visit any `facebook.com` page. In the page's DevTools
  console you should see
  `Marketplace Detour Router: content script active on <url>`, and a small
  low-opacity "Detour Router Active" badge in the bottom-right corner. Hovering
  makes it fully opaque; clicking dismisses it.

The content script currently matches all of `*://*.facebook.com/*` to make QA
easier. It will be scoped down to `/marketplace/*` once real routing logic lands.

## How location extraction works

`extractListingLocation()` in `content.js` reads the numbers straight out of the
static map image URL, which is in the DOM on page load — no clicking, no tile
maths. A `<div>` carries an inline `--x-backgroundImage` pointing at
`static_map.php`, whose query string holds:

- `center=<lat>,<lon>` — the approximate centre
- `circle=weight:…|color:…|fillcolor:…|<lat>,<lon>|2k` — last segment is the
  radius, `2k` meaning 2 km

The element is found via `[style*="static_map"]`, and the URL is read from the
live `style` object first, then the raw `style` attribute. Attribute text is
entity-escaped (`&amp;`), so it is normalised before parsing. If `center` is
missing, the circle's own lat/lon pair is used instead.

Location text ("Columbia, MO") comes from the `<place> · Location is approximate`
caption under the map, stripped of the caption itself — which also handles
non-US forms like "New Territories, Hong Kong SAR".

### Known limits

- These are Facebook's **fuzzed** coordinates — the centre of the approximate
  circle, not a precise address.
- Parsing depends on Facebook's markup and query-string format, so a change on
  their side can break it. The popup's debug line shows `static map y/n` to
  distinguish "element missing" from "parse failed".

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest |
| `background.js` | Service worker (logs on install) |
| `popup.html` / `popup.css` / `popup.js` | Toolbar popup; asks the content script for listing info |
| `content.js` | Active badge, static-map location extraction, message handler |

No icons are bundled yet, so Chrome shows a default placeholder icon in the toolbar.
