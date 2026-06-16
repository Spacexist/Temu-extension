const STORAGE_KEY = "priceFillerCoefficient";
const SUPPORTED_HOSTS = new Set(["agentseller.temu.com", "seller.kuajingmaihuo.com"]);

const startBtn = document.getElementById("startBtn");
const coeffInput = document.getElementById("coefficient");
const formulaCoeff = document.getElementById("formulaCoeff");
const logBox = document.getElementById("logBox");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const statusCount = document.getElementById("statusCount");
const warningBanner = document.getElementById("warning");

let isRunning = false;
let currentTabId = null;

chrome.storage.local.get([STORAGE_KEY], (data) => {
  if (data[STORAGE_KEY]) {
    coeffInput.value = data[STORAGE_KEY];
    formulaCoeff.textContent = data[STORAGE_KEY];
  }
});

coeffInput.addEventListener("input", () => {
  formulaCoeff.textContent = coeffInput.value;
  chrome.storage.local.set({ [STORAGE_KEY]: coeffInput.value });
});

startBtn.addEventListener("click", async () => {
  if (isRunning) {
    await stopRunningTask();
    return;
  }

  await startFilling();
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message?.type?.startsWith("price-filler:")) {
    return;
  }

  if (message.type === "price-filler:log") {
    addLog(message.text, message.level || "");
    return;
  }

  if (message.type === "price-filler:status") {
    statusCount.textContent = `${message.filled} / ${message.total}`;
    return;
  }

  if (message.type === "price-filler:done") {
    finishRunningState("完成");
    statusDot.className = "status-dot done";
    statusCount.textContent = `${message.filled} / ${message.total}`;
    addLog(`完成：共填写 ${message.filled} 个建议零售价`, "done");
    return;
  }

  if (message.type === "price-filler:error") {
    finishRunningState("出错");
    addLog(`错误：${message.text}`, "error");
  }
});

window.addEventListener("focus", refreshPageAvailability);
chrome.tabs.onActivated.addListener(refreshPageAvailability);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    refreshPageAvailability();
  }
});

refreshPageAvailability();

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

function isSupportedUrl(url) {
  try {
    const parsedUrl = new URL(url || "");
    return parsedUrl.protocol === "https:" && SUPPORTED_HOSTS.has(parsedUrl.hostname);
  } catch (_error) {
    return false;
  }
}

async function refreshPageAvailability() {
  const tab = await getCurrentTab();
  currentTabId = tab?.id ?? null;
  const supported = Boolean(tab?.id && isSupportedUrl(tab.url));

  warningBanner.classList.toggle("show", !supported);
  startBtn.disabled = !supported && !isRunning;

  if (!supported && !isRunning) {
    statusText.textContent = "等待目标页面";
  } else if (!isRunning) {
    statusText.textContent = "就绪";
  }
}

function clearLog() {
  logBox.innerHTML = "";
}

function addLog(message, type = "") {
  const line = document.createElement("div");
  line.className = `log-line ${type}`;
  line.textContent = message;
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}

async function startFilling() {
  const coefficient = Number(coeffInput.value);
  if (!Number.isFinite(coefficient) || coefficient <= 0) {
    addLog("系数无效，请输入大于 0 的数字。", "error");
    return;
  }

  const tab = await getCurrentTab();
  if (!tab?.id || !isSupportedUrl(tab.url)) {
    warningBanner.classList.add("show");
    addLog("当前页面不是支持的 Temu 后台。", "warn");
    return;
  }

  isRunning = true;
  currentTabId = tab.id;
  clearLog();
  addLog(`开始填写，系数 ×${coefficient}`, "info");
  startBtn.textContent = "停止";
  startBtn.className = "btn btn-stop";
  statusDot.className = "status-dot active";
  statusText.textContent = "运行中";
  statusCount.textContent = "0 / 0";
  coeffInput.disabled = true;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["src/presentation/priceFiller/content.js"]
    });
  } catch (_error) {
    // Manifest content script may already be loaded.
  }

  chrome.tabs.sendMessage(tab.id, {
    action: "price-filler:start",
    coefficient
  });
}

async function stopRunningTask() {
  if (currentTabId) {
    try {
      await chrome.tabs.sendMessage(currentTabId, { action: "price-filler:stop" });
    } catch (_error) {
      // The tab may have navigated away.
    }
  }

  finishRunningState("已停止");
  addLog("已手动停止。", "warn");
}

function finishRunningState(label) {
  isRunning = false;
  startBtn.textContent = "开始填写当前页";
  startBtn.className = "btn btn-primary";
  statusDot.className = "status-dot";
  statusText.textContent = label;
  coeffInput.disabled = false;
  refreshPageAvailability();
}
