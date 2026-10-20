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
- **Saved locations:** click "Get current location", approve the OS prompt,
  type a label and Save. The entry persists across closing and reopening the
  popup. Use the radio button to mark one active, and `×` to delete.
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

## Setup: Mapbox token

Address lookup uses the Mapbox Geocoding API.

1. Copy `config.example.js` to `config.js`
2. Paste your token into `MAPBOX_TOKEN`
3. Reload the extension

`config.js` is gitignored so the token is never committed. Without it the
address features report "Paste your Mapbox token into config.js" and make no
network request; everything else keeps working.

The manifest grants `https://api.mapbox.com/*` as a host permission — MV3 blocks
the fetch without it.

## Saved locations

Stored in `chrome.storage.local` under two keys:

- `savedLocations` — array of `{ id, label, address, lat, lon, createdAt }`
- `activeLocationId` — id of the selected entry, or `null`

Two ways to add one, both funnelling into the same confirm-and-label step:

- **Get current location** — GPS, then reverse geocoding for a readable address.
  If that lookup fails the entry still saves, showing "Address unavailable".
- **Search for an address** — type at least 3 characters and a scrollable list
  of up to 5 candidates appears. Nothing is chosen for you: click a row, or use
  ↑/↓ and Enter. Escape closes the list. No match shows an error and saves
  nothing.

Lookups are debounced 300 ms, and each new keystroke aborts the previous
request so a slow earlier response can't overwrite results for what you have
actually typed. If a saved location is marked active, it is sent as Mapbox's
`proximity` hint so nearby matches rank first.

Mapbox returns coordinates as `[longitude, latitude]`, reversed from the
`lat, lon` order used everywhere else here. `coordsFromFeature()` is the single
place that conversion happens, and it rejects pairs whose latitude is out of
range — which is what a silent swap looks like.

Entries saved before addresses existed load fine; their address shows as
"Address unavailable".

Deleting the active entry clears `activeLocationId`. Malformed entries are
dropped on load, so a corrupted store degrades to an empty list rather than
breaking the popup.

**The manifest needs the `geolocation` permission** (added). Extension pages get
no permission prompt, so without it `getCurrentPosition()` just fails. On macOS,
Chrome itself must also be allowed under System Settings → Privacy & Security →
Location Services, or the call fails with a denial no matter what the extension
declares.

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
| `config.js` | Mapbox token (gitignored; copy from `config.example.js`) |

No icons are bundled yet, so Chrome shows a default placeholder icon in the toolbar.
