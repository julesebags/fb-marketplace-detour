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
