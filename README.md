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
- **Side panel:** click the toolbar icon. The panel docks to the side of the
  window and stays open while you browse; drag its edge to widen it. On a
  listing page the Listing section shows:

  ```
  Location          Columbia, MO
  Coordinates       38.883362, -92.246704
  Approx. radius    2 km
  ```

  Anywhere else it falls back to "Open a listing to see its location."
- **Routes:** with a listing open and a saved location chosen as the start, the
  map draws driving routes. Click a route row or a grey line on the map to
  switch between alternatives.
- **Saved locations:** click "Get current location", approve the OS prompt,
  type a label and Save. The entry persists across reopening the panel. Use the
  radio button to mark one active, and `×` to delete.
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

## UI: side panel, not a popup

Everything lives in `sidepanel.html`, shown through Chrome's Side Panel API. The
manifest has **no `default_popup`** — that omission is what lets
`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` in
`background.js` take over the toolbar click. Adding `default_popup` back would
silently reinstate the popup.

The panel stays open while you browse, so it listens to `chrome.tabs.onActivated`
and `onUpdated` and re-reads the listing whenever the active tab changes. Routes
refetch only when the destination actually moves.

## Driving routes

Mapbox Directions with `alternatives=true`, driving profile, rendered on an
interactive Leaflet map: pan, zoom, drag. The selected route draws in blue, the
alternatives in grey underneath; click either a route row or a grey line to
switch. Each row shows travel time, distance and road summary.

**Leaflet is vendored** in `vendor/leaflet/` (1.9.4, BSD-2-Clause, ~147KB). MV3
forbids loading scripts from a CDN, so a map library has to live in the repo.
Leaflet rather than Mapbox GL JS because GL JS creates its web worker from a
`blob:` URL, and MV3 rejects `blob:` in an extension page's CSP outright — the
manifest will not even load. Leaflet is plain JS with no workers and no WASM.

Directions are requested with `geometries=geojson`, so the route arrives as
coordinates rather than an encoded polyline and needs no decoder. GeoJSON is
`[lon, lat]`; Leaflet wants `[lat, lng]`. `toLatLngs()` is the single place that
swap happens, and it drops pairs whose latitude is out of range — which is what
a silent reversal looks like.

### Approximate vs confirmed destinations

What `static_map.php` gives us is the **centre of Facebook's fuzz circle**, not
the item's address. With a 2 km radius the item is somewhere in ~12.5 km², and
the centre is almost certainly not it. The map says so honestly:

- **Unconfirmed** — a dashed red circle at the real radius, with a hollow pin at
  its centre. The pin is a guess; the circle is the actual claim.
- **Confirmed** — a solid pin at the exact address, the old circle kept faint in
  grey with a small dot at its centre, so the gap between the two is visible.

If a seller tells you the real address, set it in the Listing section's address
box. It is stored per listing id under `listingOverrides` in
`chrome.storage.local`, so it survives reloads and reappears whenever you return
to that listing. Routes are computed to the confirmed point when one exists.
"Clear" reverts to the approximate centre. Listings whose id can't be read from
the URL hide the control, since there would be nothing to key the override to.

`resolveDestination()` is the single place that choice is made, and it ignores a
stored override whose coordinates are out of range rather than preferring it
blindly.

The "Listings along this route" panel is a deliberate placeholder for the next
step.

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
| `sidepanel.html` / `.css` / `.js` | The whole UI: listing info, map, routes, saved locations |
| `content.js` | Active badge, static-map location extraction, message handler |
| `vendor/leaflet/` | Vendored Leaflet 1.9.4 (MV3 forbids CDN scripts) |
| `config.js` | Mapbox token (gitignored; copy from `config.example.js`) |

No icons are bundled yet, so Chrome shows a default placeholder icon in the toolbar.
