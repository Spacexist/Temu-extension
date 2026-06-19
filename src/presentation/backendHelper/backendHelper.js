const statusEl = document.querySelector("#status");
const statusBadge = document.querySelector("#statusBadge");
const statusDot = document.querySelector("#statusDot");
const logBox = document.querySelector("#logBox");
const startFlowBtn = document.querySelector("#startFlow");
const stopFlowBtn = document.querySelector("#stopFlow");
const autoConfirmEl = document.querySelector("#autoConfirm");
const flowModeEl = document.querySelector("#flowMode");

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function canInject(tab) {
  return tab && /^https?:\/\//.test(tab.url || "");
}

function describeBlockedTab(tab) {
  const url = tab?.url || "未知页面";
  if (url.startsWith("chrome://") || url.startsWith("edge://") || url.startsWith("chrome-extension://")) {
    return `当前活动标签页是 Chrome 内部页，浏览器禁止扩展注入脚本：${url}`;
  }
  return `当前活动标签页不可注入：${url}`;
}

function setStatus(message, variant = "warn") {
  statusEl.textContent = message;
  statusBadge.textContent = variant === "ready" ? "就绪" : "注意";
  statusBadge.className = variant;
  statusDot.className = `status-dot ${variant}`;
}

function addLog(message, level = "info") {
  if (!logBox) return;
  if (logBox.children.length === 1 && logBox.textContent.includes("等待执行")) {
    logBox.innerHTML = "";
  }
  const line = document.createElement("div");
  line.className = `log-line ${level}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}

async function ensureContentScript(tab) {
  try {
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["src/presentation/backendHelper/content.css"]
    });
  } catch (_cssError) {}

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["src/presentation/backendHelper/content.js"]
  });
}

async function sendMessage(message) {
  const tab = await getActiveTab();
  if (!canInject(tab)) {
    throw new Error(describeBlockedTab(tab));
  }

  await ensureContentScript(tab);
  await new Promise((resolve) => setTimeout(resolve, 120));
  return chrome.tabs.sendMessage(tab.id, message);
}
async function refreshStatus() {
  try {
    const response = await sendMessage({ type: "TC65_WORKBENCH_STATUS" });
    setStatus(response?.message || "助手已就绪。", "ready");
    startFlowBtn.disabled = false;
    stopFlowBtn.disabled = false;
  } catch (error) {
    setStatus(error.message || String(error), "warn");
    startFlowBtn.disabled = true;
    stopFlowBtn.disabled = true;
  }
}

startFlowBtn.addEventListener("click", async () => {
  try {
    addLog(`开始处理：${flowModeEl.options[flowModeEl.selectedIndex]?.textContent || flowModeEl.value}`, "info");
    await sendMessage({
      type: "TC65_WORKBENCH_RUN",
      mode: flowModeEl.value,
      autoConfirm: autoConfirmEl.checked
    });
    setStatus("已开始处理，请在下方日志查看进度。", "ready");
  } catch (error) {
    setStatus(error.message || String(error), "warn");
  }
});

stopFlowBtn.addEventListener("click", async () => {
  try {
    await sendMessage({ type: "TC65_WORKBENCH_STOP" });
    setStatus("已发送停止请求。", "ready");
  } catch (error) {
    setStatus(error.message || String(error), "warn");
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "backend-helper:status") {
    setStatus(message.message || "执行中", message.level === "error" ? "warn" : "ready");
    return;
  }

  if (message?.type === "backend-helper:log") {
    addLog(message.message || "", message.level || "info");
  }
});

flowModeEl.addEventListener("change", refreshStatus);
refreshStatus();






