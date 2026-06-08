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
const clearLogButton = document.getElementById("clearLogButton");
const logList = document.getElementById("logList");

let currentStatus = null;
let currentTab = null;
let logs = [];
let shortcutLogged = false;

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

function addLog(text) {
  logs.unshift({
    time: new Date().toLocaleTimeString(),
    text: String(text)
  });
  logs = logs.slice(0, 80);
  renderLogs();
}

function renderLogs() {
  if (!logs.length) {
    logList.textContent = "暂无日志";
    return;
  }

  logList.replaceChildren(
    ...logs.map((entry) => {
      const row = document.createElement("div");
      row.className = "log-entry";
      row.textContent = `${entry.time}  ${entry.text}`;
      return row;
    })
  );
}

function getExtensionCommands() {
  return new Promise((resolve) => {
    if (!chrome?.commands?.getAll) {
      resolve([]);
      return;
    }

    chrome.commands.getAll((commands) => {
      if (chrome.runtime.lastError) {
        resolve([]);
        return;
      }
      resolve(commands || []);
    });
  });
}

async function logShortcutAssignment(force = false) {
  if (shortcutLogged && !force) return;
  shortcutLogged = true;

  const commands = await getExtensionCommands();
  const command = commands.find((item) => item.name === "toggle-temu-split");

  if (command?.shortcut) {
    addLog(`Chrome 快捷键已分配：${command.shortcut}`);
    return;
  }

  addLog("Chrome 未分配 Alt+W；请在 chrome://extensions/shortcuts 手动设置。侧边栏或 Temu 页面聚焦时仍会兜底捕获 Alt+W。");
}

function renderStatus(status) {
  currentStatus = status;
  enabledStatus.textContent = status.enabled ? "已开启" : "已关闭";
  detailStatus.textContent = status.hasDetailTab ? `已连接 #${status.detailTabId}` : "未创建";
  sourceStatus.textContent = status.currentBlockedSellerCenter
    ? "卖家中心禁用"
    : (status.hasSourceTab ? `已绑定 #${status.sourceTabId}` : "未绑定");

  if (status.currentBlockedSellerCenter) {
    splitStatus.textContent = "禁止拦截/采集";
  } else if (status.sameSplitView) {
    splitStatus.textContent = "已检测到同组分屏";
  } else if (status.splitViewSupported) {
    splitStatus.textContent = "可检测，未同组";
  } else {
    splitStatus.textContent = "当前 Chrome 未暴露状态";
  }

  toggleButton.textContent = status.enabled ? "关闭商品点击拦截" : "开启商品点击拦截";
  focusDetailButton.disabled = !status.hasDetailTab && !status.lastDetailUrl;
  bindSourceButton.disabled = Boolean(status.currentBlockedSellerCenter);
}

async function refreshStatus() {
  addLog("刷新分屏状态。");
  logShortcutAssignment();
  currentTab = await queryActiveTab();
  const response = await sendMessage({
    type: "TEMU_SPLIT_GET_STATUS",
    currentTabId: currentTab?.id ?? null
  });

  if (!response.ok) {
    setMessage(response.error || "读取状态失败。", true);
    addLog(`读取状态失败：${response.error || "未知错误"}`);
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
    bindSourceButton.disabled = Boolean(currentStatus?.currentBlockedSellerCenter);
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
    addLog(response.ok ? `按钮切换：${response.status.enabled ? "已开启" : "已关闭"}` : `按钮切换失败：${response.error || "未知错误"}`);
  });
});

focusDetailButton.addEventListener("click", () => {
  runAction(async () => {
    const response = await sendMessage({
      type: "TEMU_SPLIT_FOCUS_DETAIL_TAB",
      currentTabId: currentTab?.id ?? null
    });
    setMessage(response.ok ? "已定位详情标签。" : response.error || "无法定位详情标签。", !response.ok);
    addLog(response.ok ? "已定位详情标签。" : `定位详情标签失败：${response.error || "未知错误"}`);
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
    addLog(response.ok ? "已绑定当前页为列表页。" : `绑定列表页失败：${response.error || "未知错误"}`);
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
    addLog(response.ok ? "已绑定当前页为详情标签。" : `绑定详情标签失败：${response.error || "未知错误"}`);
  });
});

clearDetailButton.addEventListener("click", () => {
  runAction(async () => {
    const response = await sendMessage({
      type: "TEMU_SPLIT_CLEAR_DETAIL_RECORD",
      currentTabId: currentTab?.id ?? null
    });
    setMessage(response.ok ? "已清除详情标签记录。" : response.error || "清除失败。", !response.ok);
    addLog(response.ok ? "已清除详情标签记录。" : `清除详情标签记录失败：${response.error || "未知错误"}`);
  });
});

clearLogButton.addEventListener("click", () => {
  logs = [];
  renderLogs();
});

document.addEventListener("keydown", (event) => {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.code !== "KeyW") return;
  event.preventDefault();
  addLog("捕获侧边栏 Alt+W，执行兜底切换。");
  toggleButton.click();
});

if (chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "TEMU_SPLIT_LOG") return;
    addLog(message.text || "收到后台日志。");
    refreshStatus();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", refreshStatus);
} else {
  refreshStatus();
}
