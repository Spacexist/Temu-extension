const STORAGE_KEY = "compatSidepanelActivePanel";
const SUBTOOL_STORAGE_KEY = "compatSidepanelDxmPriceTool";

const tabs = Array.from(document.querySelectorAll(".segment-tab"));
const panels = Array.from(document.querySelectorAll(".panel"));
const subtoolTabs = Array.from(document.querySelectorAll(".subnav-tab"));
const subtoolFrames = Array.from(document.querySelectorAll(".tool-frame"));
const panel1688Frame = document.querySelector("#panel1688 iframe");
const PANEL_ALIASES = {
  panelAuxiliary: "panelGpt",
  panelTemuSplit: "panelSplit",
  panelSplit: "panelSplit",
  panelGpt: "panelGpt",
  panelDxm: "panelDxmPrice",
  panelPrice: "panelDxmPrice",
  panelDxmPrice: "panelDxmPrice"
};

for (const tab of tabs) {
  tab.addEventListener("click", () => {
    activatePanel(tab.dataset.panel);
  });
}

for (const tab of subtoolTabs) {
  tab.addEventListener("click", () => {
    activateSubtool(tab.dataset.tool);
  });
}

activateSubtool(localStorage.getItem(SUBTOOL_STORAGE_KEY) || "dxm");
activatePanel(resolvePanelId(localStorage.getItem(STORAGE_KEY) || "panel1688"));

if (chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "product-collection-refresh") {
      panel1688Frame?.contentWindow?.postMessage(message, window.location.origin);
      return;
    }

    if (message?.type !== "active-tab-changed" || !message.is1688DetailPage) {
      return;
    }

    activatePanel("panel1688");
    panel1688Frame?.contentWindow?.postMessage(message, window.location.origin);
  });
}

function activatePanel(panelId) {
  const nextPanelId = resolvePanelId(panelId);

  for (const tab of tabs) {
    const isActive = tab.dataset.panel === nextPanelId;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  }

  for (const panel of panels) {
    const isActive = panel.id === nextPanelId;
    panel.classList.toggle("is-active", isActive);
    panel.toggleAttribute("hidden", !isActive);
  }

  localStorage.setItem(STORAGE_KEY, nextPanelId);

  if (nextPanelId === "panel1688") {
    panel1688Frame?.contentWindow?.postMessage({ type: "product-collection-refresh" }, window.location.origin);
  }
}

function activateSubtool(toolId) {
  const nextToolId = subtoolFrames.some((frame) => frame.dataset.toolFrame === toolId) ? toolId : "dxm";

  for (const tab of subtoolTabs) {
    const isActive = tab.dataset.tool === nextToolId;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  }

  for (const frame of subtoolFrames) {
    const isActive = frame.dataset.toolFrame === nextToolId;
    frame.classList.toggle("is-active", isActive);
    frame.toggleAttribute("hidden", !isActive);
  }

  localStorage.setItem(SUBTOOL_STORAGE_KEY, nextToolId);
}

function resolvePanelId(panelId) {
  const aliasedPanelId = PANEL_ALIASES[panelId] || panelId;
  if (panels.some((panel) => panel.id === aliasedPanelId)) {
    return aliasedPanelId;
  }
  return "panel1688";
}
