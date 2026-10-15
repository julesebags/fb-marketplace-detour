# fb-marketplace-detour

Chrome extension (Manifest V3) scaffold for **Marketplace Detour Router**.

Current state: scaffold only — no routing logic yet. The extension loads, shows a
placeholder popup, and proves it is running on Facebook pages.

## Load unpacked in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle, top right)
3. Click **Load unpacked**
4. Select this folder (the repo root, containing `manifest.json`)

## What to expect when testing

- **No errors** on the extension card in `chrome://extensions`.
- **Service worker:** click "service worker" on the extension card to open its
  console. On install/reload you should see `Marketplace Detour Router installed`.
- **Popup:** click the toolbar icon. You should see the heading
  "Marketplace Detour Router" and the line "Routing logic coming soon".
- **Content script:** visit any `facebook.com` page. In the page's DevTools
  console you should see
  `Marketplace Detour Router: content script active on <url>`, and a small
  low-opacity "Detour Router Active" badge in the bottom-right corner. Hovering
  makes it fully opaque; clicking dismisses it.

The content script currently matches all of `*://*.facebook.com/*` to make QA
easier. It will be scoped down to `/marketplace/*` once real routing logic lands.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest |
| `background.js` | Service worker (logs on install) |
| `popup.html` / `popup.css` / `popup.js` | Toolbar popup placeholder |
| `content.js` | Runs on facebook.com; logs + injects the active badge |

No icons are bundled yet, so Chrome shows a default placeholder icon in the toolbar.
