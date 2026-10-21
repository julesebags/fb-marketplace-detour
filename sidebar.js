// In-page sidebar for Marketplace pages. Lives in a Shadow DOM root so
// Facebook's CSS cannot reach in and ours cannot leak out.
(function () {
  "use strict";

  const NS = (window.DetourRouter = window.DetourRouter || {});
  const LOG = "[DetourRouter]";

  const HOST_ID = "detour-router-sidebar";
  const PATH_POLL_MS = 1000;

  let host = null;
  let ui = {};
  let isRunning = false;
  let collapsed = false;
  let isWorkerTab = false;

  const CSS = `
    .panel {
      position: fixed;
      top: 0;
      right: 0;
      width: 340px;
      height: 100vh;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      background: #ffffff;
      color: #1c1e21;
      border-left: 1px solid #ced0d4;
      box-shadow: -2px 0 12px rgba(0, 0, 0, 0.18);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
      line-height: 1.4;
    }
    .panel[hidden], .tab[hidden] { display: none; }

    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid #e4e6eb;
    }
    .title { flex: 1; font-size: 14px; font-weight: 600; color: #1c1e21; }

    .icon-button {
      flex: 0 0 auto;
      width: 24px;
      height: 24px;
      padding: 0;
      border: 1px solid #ced0d4;
      border-radius: 6px;
      background: #f0f2f5;
      color: #1c1e21;
      font: inherit;
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
    }
    .icon-button:hover { background: #e4e6eb; }

    .controls {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid #e4e6eb;
    }
    .refresh {
      padding: 7px 12px;
      border: none;
      border-radius: 6px;
      background: #1877f2;
      color: #ffffff;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
    .refresh:hover:not(:disabled) { background: #166fe0; }
    .refresh:disabled { background: #e4e6eb; color: #bcc0c4; cursor: default; }
    .status { flex: 1; min-width: 0; color: #65676b; font-size: 12px; }

    .list {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 8px;
    }
    .empty { padding: 16px 4px; color: #8a8d91; font-size: 12px; text-align: center; }

    .card {
      display: flex;
      gap: 10px;
      padding: 8px;
      margin-bottom: 8px;
      border: 1px solid #e4e6eb;
      border-radius: 8px;
      background: #ffffff;
      color: #1c1e21;
      text-decoration: none;
    }
    .card:hover { background: #f5f6f7; }

    .thumb {
      flex: 0 0 auto;
      width: 68px;
      height: 68px;
      border-radius: 6px;
      object-fit: cover;
      background: #e4e6eb;
    }
    .thumb-placeholder {
      flex: 0 0 auto;
      width: 68px;
      height: 68px;
      border-radius: 6px;
      background: #e4e6eb;
    }

    .card-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .price { font-size: 14px; font-weight: 700; color: #1c1e21; }
    .card-title {
      font-size: 13px;
      color: #1c1e21;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .where { font-size: 12px; color: #65676b; overflow-wrap: anywhere; }

    .tab {
      position: fixed;
      top: 96px;
      right: 0;
      z-index: 2147483647;
      padding: 10px 8px;
      border: 1px solid #ced0d4;
      border-right: none;
      border-radius: 8px 0 0 8px;
      background: #ffffff;
      color: #1c1e21;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 12px;
      font-weight: 600;
      writing-mode: vertical-rl;
      cursor: pointer;
      box-shadow: -2px 0 8px rgba(0, 0, 0, 0.15);
    }
  `;

  function onMarketplacePath() {
    return window.location.pathname.startsWith("/marketplace");
  }

  function setStatus(text) {
    if (ui.status) ui.status.textContent = text;
  }

  function setCollapsed(next) {
    collapsed = next;
    if (!ui.panel) return;
    ui.panel.hidden = collapsed;
    ui.tab.hidden = !collapsed;
  }

  function renderListings(listings) {
    if (!ui.list) return;
    ui.list.textContent = "";

    if (!listings.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No listings found in the current feed.";
      ui.list.append(empty);
      return;
    }

    for (const listing of listings) {
      const card = document.createElement("a");
      card.className = "card";
      card.href = listing.url;
      card.target = "_blank";
      card.rel = "noopener noreferrer";

      if (listing.image) {
        const img = document.createElement("img");
        img.className = "thumb";
        img.src = listing.image;
        img.alt = "";
        img.loading = "lazy";
        card.append(img);
      } else {
        const placeholder = document.createElement("div");
        placeholder.className = "thumb-placeholder";
        card.append(placeholder);
      }

      const body = document.createElement("div");
      body.className = "card-body";

      // textContent throughout: scraped strings are untrusted page content.
      const price = document.createElement("div");
      price.className = "price";
      price.textContent = listing.price || "—";

      const title = document.createElement("div");
      title.className = "card-title";
      title.textContent = listing.title || listing.rawLines.join(" · ");

      const where = document.createElement("div");
      where.className = "where";
      where.textContent = listing.location || "";

      body.append(price, title, where);
      card.append(body);
      ui.list.append(card);
    }
  }

  // The work happens in a hidden worker tab driven by the background
  // service worker, so this page never navigates, scrolls or opens a modal.
  async function onRefresh() {
    if (isRunning) return;
    isRunning = true;
    ui.refresh.disabled = true;

    try {
      setStatus("Searching in background…");

      let result = null;
      try {
        result = await chrome.runtime.sendMessage({ type: "DETOUR_REFRESH" });
      } catch (error) {
        console.error(`${LOG} refresh message failed`, error);
        setStatus(`Error: ${(error && error.message) || error}`);
        return;
      }

      if (!result) {
        setStatus("Error: no response from the background worker");
        return;
      }

      const listings = Array.isArray(result.listings) ? result.listings : [];
      renderListings(listings);

      if (result.ok) {
        setStatus(`${listings.length} listings`);
      } else if (listings.length) {
        setStatus("Location update failed — showing that tab's default feed");
      } else {
        setStatus(`Error: ${result.error || "unknown"}`);
      }
    } finally {
      isRunning = false;
      if (ui.refresh) ui.refresh.disabled = false;
    }
  }

  function mount() {
    if (document.getElementById(HOST_ID) || !document.body) return;

    host = document.createElement("div");
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = CSS;

    const panel = document.createElement("div");
    panel.className = "panel";

    const header = document.createElement("div");
    header.className = "header";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "Detour Router";
    const toggle = document.createElement("button");
    toggle.className = "icon-button";
    toggle.type = "button";
    toggle.textContent = "–";
    toggle.title = "Collapse";
    toggle.addEventListener("click", () => setCollapsed(true));
    header.append(title, toggle);

    const controls = document.createElement("div");
    controls.className = "controls";
    const refresh = document.createElement("button");
    refresh.className = "refresh";
    refresh.type = "button";
    refresh.textContent = "Refresh";
    refresh.addEventListener("click", onRefresh);
    const status = document.createElement("div");
    status.className = "status";
    status.textContent = "Idle";
    controls.append(refresh, status);

    const list = document.createElement("div");
    list.className = "list";
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Click Refresh to load listings.";
    list.append(empty);

    panel.append(header, controls, list);

    const tab = document.createElement("button");
    tab.className = "tab";
    tab.type = "button";
    tab.textContent = "Detour Router";
    tab.hidden = true;
    tab.addEventListener("click", () => setCollapsed(false));

    shadow.append(style, panel, tab);
    document.body.append(host);

    ui = { panel, tab, refresh, status, list };
    setCollapsed(collapsed);
    console.log(`${LOG} sidebar mounted`);
  }

  function unmount() {
    const existing = document.getElementById(HOST_ID);
    if (!existing) return;
    existing.remove();
    host = null;
    ui = {};
    console.log(`${LOG} sidebar unmounted`);
  }

  function sync() {
    // The worker tab runs the same content scripts; it must stay headless.
    if (isWorkerTab) {
      unmount();
      return;
    }
    if (onMarketplacePath()) mount();
    else unmount();
  }

  async function detectWorkerTab() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "DETOUR_AM_I_WORKER",
      });
      isWorkerTab = !!(response && response.isWorker);
    } catch (error) {
      // No answer: assume this is the user's own tab and show the sidebar.
      isWorkerTab = false;
    }
    if (isWorkerTab) console.log(`${LOG} worker tab — sidebar suppressed`);
  }

  // Facebook is a single-page app: there is no navigation event to hook,
  // so poll the path and mount/unmount as it changes. Ask first, so the
  // worker tab never flashes a sidebar.
  detectWorkerTab().then(() => {
    sync();
    setInterval(sync, PATH_POLL_MS);
  });

  NS.sidebar = { mount, unmount, renderListings, setStatus };
})();
