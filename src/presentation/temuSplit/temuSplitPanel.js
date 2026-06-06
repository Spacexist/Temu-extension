const enabledStatus = document.getElementById("enabledStatus");
const detailStatus = document.getElementById("detailStatus");
const sourceStatus = document.getElementById("sourceStatus");
const splitStatus = document.getElementById("splitStatus");
const messageBox = document.getElementById("message");
const toggleButton = document.getElementById("toggleButton");
const focusDetailButton = document.getElementById("focusDetailButton");
const bindSourceButton = document.getElementById("bindSourceButton");
const bindDetailButton = document.getElementById("bindDetailButton");
const clearDetailButton = document.getElementById("clearDetailButton");

let currentStatus = null;
let currentTab = null;

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "扩展未响应。" });
    });
  });
}

function queryActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs?.[0] || null);
    });
  });
}

function setMessage(text, isError = false) {
  messageBox.textContent = text || "";
  messageBox.style.color = isError ? "#b91c1c" : "#b45309";
}

function renderStatus(status) {
  currentStatus = status;
  enabledStatus.textContent = status.enabled ? "已开启" : "已关闭";
  detailStatus.textContent = status.hasDetailTab ? `已连接 #${status.detailTabId}` : "未创建";
  sourceStatus.textContent = status.hasSourceTab ? `已绑定 #${status.sourceTabId}` : "未绑定";

  if (status.sameSplitView) {
    splitStatus.textContent = "已检测到同组分屏";
  } else if (status.splitViewSupported) {
    splitStatus.textContent = "可检测，未同组";
  } else {
    splitStatus.textContent = "当前 Chrome 未暴露状态";
  }

  toggleButton.textContent = status.enabled ? "关闭商品点击拦截" : "开启商品点击拦截";
  focusDetailButton.disabled = !status.hasDetailTab && !status.lastDetailUrl;
}

async function refreshStatus() {
  currentTab = await queryActiveTab();
  const response = await sendMessage({
    type: "TEMU_SPLIT_GET_STATUS",
    currentTabId: currentTab?.id ?? null
  });

  if (!response.ok) {
    setMessage(response.error || "读取状态失败。", true);
    return;
  }

  renderStatus(response.status);
}

async function runAction(action) {
  setMessage("");
  toggleButton.disabled = true;
  focusDetailButton.disabled = true;
  bindSourceButton.disabled = true;
  bindDetailButton.disabled = true;
  clearDetailButton.disabled = true;

  try {
    await action();
  } finally {
    toggleButton.disabled = false;
    bindSourceButton.disabled = false;
    bindDetailButton.disabled = false;
    clearDetailButton.disabled = false;
    await refreshStatus();
  }
}

toggleButton.addEventListener("click", () => {
  runAction(async () => {
    const response = await sendMessage({
      type: "TEMU_SPLIT_SET_ENABLED",
      enabled: !currentStatus?.enabled,
      currentTabId: currentTab?.id ?? null
    });

    setMessage(response.ok ? (response.status.enabled ? "已开启拦截。" : "已关闭拦截。") : response.error || "切换失败。", !response.ok);
  });
});

focusDetailButton.addEventListener("click", () => {
  runAction(async () => {
    const response = await sendMessage({
      type: "TEMU_SPLIT_FOCUS_DETAIL_TAB",
      currentTabId: currentTab?.id ?? null
    });
    setMessage(response.ok ? "已定位详情标签。" : response.error || "无法定位详情标签。", !response.ok);
  });
});

bindSourceButton.addEventListener("click", () => {
  runAction(async () => {
    const latestTab = await queryActiveTab();
    const response = await sendMessage({
      type: "TEMU_SPLIT_BIND_SOURCE_TAB",
      tabId: latestTab?.id ?? null
    });
    setMessage(response.ok ? "已绑定当前页为列表页。" : response.error || "绑定失败。", !response.ok);
  });
});

bindDetailButton.addEventListener("click", () => {
  runAction(async () => {
    const latestTab = await queryActiveTab();
    const response = await sendMessage({
      type: "TEMU_SPLIT_BIND_DETAIL_TAB",
      tabId: latestTab?.id ?? null
    });
    setMessage(response.ok ? "已绑定当前页为详情标签。" : response.error || "绑定失败。", !response.ok);
  });
});

clearDetailButton.addEventListener("click", () => {
  runAction(async () => {
    const response = await sendMessage({
      type: "TEMU_SPLIT_CLEAR_DETAIL_RECORD",
      currentTabId: currentTab?.id ?? null
    });
    setMessage(response.ok ? "已清除详情标签记录。" : response.error || "清除失败。", !response.ok);
  });
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", refreshStatus);
} else {
  refreshStatus();
}
