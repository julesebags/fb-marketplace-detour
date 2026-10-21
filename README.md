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

## Hidden worker tab

Refresh does not touch the page you are on. `sidebar.js` sends
`DETOUR_REFRESH` to `background.js`, which:

1. Resolves coordinates and logs
   `using lat=… lon=… radius=…km source=constants|saved location`
2. Opens `facebook.com/marketplace/#detour-geo=<lat>,<lon>` as an inactive tab
3. Waits for it to load (`geo-override.js` has already spoofed it at
   `document_start`)
4. Pings until the content script answers (a tab reporting "complete" is not
   the same as a content script being ready)
5. Sends `DETOUR_RUN_WORKER` with the target coordinates; the worker runs
   steps A–H, verifies the map centre, and scrapes
6. **Always** closes the tab in a `finally`, including on timeout
7. Returns `{ ok, listings, error }` to the sidebar

Coordinates are defined in exactly one place, the top of `background.js`:
`OVERRIDE_LAT`, `OVERRIDE_LON`, `DEFAULT_RADIUS_KM`, plus `USE_SAVED_LOCATION`
(read the selected saved location instead) and `DEBUG_KEEP_WORKER_TAB` (leave
the worker tab open and log its id, so its console can be read).

One run at a time; a second Refresh while one is in flight is refused with
"already running". The whole run is capped at 45 s.

The worker tab loads the same content scripts, so `sidebar.js` asks the
background `DETOUR_AM_I_WORKER` before mounting and stays headless if the
answer is yes.

### If the hidden feed comes back empty

Chrome throttles background tabs — timers slow, lazy-loading can stall. Set
`WORKER_MODE = "unfocused-window"` in `background.js` to use a real but
unfocused popup window instead, which is not throttled the same way.
Everything else is identical, including closing the window afterwards.

### Geolocation override

`geo-override.js` runs in the **MAIN** world at `document_start` on every
`https://www.facebook.com/*` page — but **does nothing unless the tab is
marked.** Patching from the isolated world would only change what the
extension sees, not what Facebook's page code sees.

The mark arrives once, as a `#detour-geo=<lat>,<lon>` hash on the URL the
background opens. At `document_start` the script:

1. parses the hash, stores the coordinates in `sessionStorage`, and strips the
   marker with `history.replaceState`
2. otherwise reads `sessionStorage` — absent means a normal tab, so it returns
   without touching anything
3. with coordinates, replaces `Geolocation.prototype.getCurrentPosition` and
   `watchPosition` (and the instance), then logs `[DetourRouter][geo] override
   active`

`sessionStorage` is per-tab, so the mark survives Facebook's own redirects and
reloads **inside the worker tab** and is invisible everywhere else.

This replaced a `chrome.scripting.executeScript` injection that ran after the
tab loaded. That was too late to be reliable — Facebook can capture a reference
to the real methods during startup. `document_start` lands before any page
script runs.

### Verifying the spoof took

The modal's map centre is the only evidence the override worked. Step D waits
for it to land within **0.01°** of the target in both lat and lon (5 s). If the
centre is already within tolerance, step D passes immediately and locate-me is
skipped.

On timeout the run **refuses to click Apply**, clicks the dialog's Close button
and returns

```
step D: map center never reached target (saw <lat,lon>, wanted <lat,lon>)
```

which reaches the sidebar status line and the service-worker console. Applying
anyway would return listings from the wrong place and look like success — the
exact failure this guards against. For the same reason the worker only scrapes
when step D passed.

`applyOverriddenLocation()` returns `{ ok, error }` rather than a boolean, so
every failing step names itself.

### Applying it to Marketplace search

Clicking **Refresh** in the in-page sidebar runs `applyOverriddenLocation()`
from `location-modal.js`, which drives Facebook's own modal in labelled steps:

| Step | What it does |
| --- | --- |
| 0 | Snapshot the first 5 listing ids |
| A | Click the `· N km` summary button (shortest text = innermost) |
| B | Wait for `[role="dialog"][aria-label="Change location"]` |
| C | Read the modal map's centre from its `static_map.php` URL |
| D | Click locate-me, wait for the centre to move > 0.0001° |
| E | Set the radius combobox (options are portalled outside the dialog) |
| F | Click Apply |
| G | Wait for the dialog to close |
| H | Wait for the listing ids to change |

Every selector anchors on `role`, `aria-label` or visible text. Facebook's
generated class names (`x1i10hfl` and friends) are never used — they churn.

`realClick()` dispatches the full `pointerdown → mousedown → pointerup →
mouseup → click` sequence, because Facebook's buttons are React handlers on
`div[role="button"]` that a bare `.click()` does not satisfy. It never clicks an
SVG; the locate-me fallback resolves `.closest('[role="button"]')` first.

`waitFor()` polls and resolves `null` on timeout rather than throwing, so a
failed step reports its own label instead of aborting the run. Every log is
prefixed `[DetourRouter]` and names its step.

Steps D and H warn and continue on timeout — an unchanged map centre or an
unchanged feed is expected when the override already matches the current
location. Only A, B, D (button missing) and F abort.

### Scope and side effects

- **Only the worker tab is spoofed.** Your own tabs report real coordinates;
  the override is injected into the short-lived hidden tab and dies with it.
- **The side panel is unaffected.** It is a `chrome-extension://` page, so
  "Get current location" still uses real GPS.
- `watchPosition` reports one fix and then goes quiet; it does not move over
  time. `clearWatch` is a no-op that accepts the ids `watchPosition` hands out.

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
| `feed-scraper.js` | Reads listing cards out of the rendered feed |
| `location-modal.js` | Drives Facebook's "Change location" modal |
| `worker.js` | Answers the background worker inside the hidden tab |
| `sidebar.js` | In-page Shadow DOM sidebar: Refresh + listing cards |
| `vendor/leaflet/` | Vendored Leaflet 1.9.4 (MV3 forbids CDN scripts) |
| `config.js` | Mapbox token (gitignored; copy from `config.example.js`) |

No icons are bundled yet, so Chrome shows a default placeholder icon in the toolbar.
