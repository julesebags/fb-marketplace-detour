chrome.runtime.onInstalled.addListener(() => {
  console.log("Marketplace Detour Router installed");
});

// Clicking the toolbar icon opens the docked side panel. There is no
// default_popup in the manifest, which is what lets this take effect.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("Side panel setup failed", error));
