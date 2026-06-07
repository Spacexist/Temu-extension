const CHATGPT_URL = "https://chatgpt.com/";
const CHATGPT_URL_PATTERN = /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\//i;
const CONTENT_SCRIPT = "src/legacy/gpt/contentScript.js";

export function createChatgptClient({ getLockedTabId, setLockedTabId }) {
  return {
    isChatgptUrl,
    openChatgptTab,
    prepareChatgptTab,
    plan,
    execute,
    stop
  };

  async function openChatgptTab() {
    await prepareChatgptTab({ active: true });
  }

  async function plan({ operationId, sequenceNumber, file, prompt, timeoutMs }) {
    const tab = await prepareChatgptTab({ active: false });
    const response = await sendToTab(tab.id, {
      type: "gpt:plan",
      operationId,
      sequenceNumber,
      file,
      prompt,
      timeoutMs
    });
    return normalizeResponse(response, operationId, "plan");
  }

  async function execute({ operationId, sequenceNumber, prompt, timeoutMs }) {
    const tab = await prepareChatgptTab({ active: false });
    const response = await sendToTab(tab.id, {
      type: "gpt:execute",
      operationId,
      sequenceNumber,
      prompt,
      timeoutMs
    });
    return normalizeResponse(response, operationId, "execute");
  }

  async function stop() {
    const tab = await getChatgptTab();
    await ensureContentScript(tab.id);
    return await sendToTab(tab.id, { type: "gpt:stop" }, 3000);
  }

  async function prepareChatgptTab({ active = false } = {}) {
    const existing = await getChatgptTab().catch(() => null);
    const tab = existing || await chrome.tabs.create({ url: CHATGPT_URL, active });
    await setLockedTabId(tab.id);

    if (existing && active) {
      await safeUpdateTab(tab.id, { active: true });
    } else if (!isChatgptUrl(tab.url)) {
      await safeUpdateTab(tab.id, { url: CHATGPT_URL, active });
    }

    await waitForTabComplete(tab.id);
    await ensureContentScript(tab.id);
    await waitForContentReady(tab.id);
    return await safeGetTab(tab.id);
  }

  async function getChatgptTab() {
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeChatgptTab = activeTabs.find((tab) => isChatgptUrl(tab.url));
    if (activeChatgptTab?.id) {
      await setLockedTabId(activeChatgptTab.id);
      return activeChatgptTab;
    }

    const lockedTabId = Number(getLockedTabId());
    if (lockedTabId) {
      const locked = await safeGetTab(lockedTabId);
      if (isChatgptUrl(locked.url)) return locked;
      await setLockedTabId(null);
    }

    const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
    if (!tabs.length) {
      throw { phase: "tab", error: "未找到 GPT 页面，请先打开并登录 ChatGPT。", diagnostics: null };
    }
    await setLockedTabId(tabs[0].id);
    return tabs[0];
  }
}

export function isChatgptUrl(url) {
  return CHATGPT_URL_PATTERN.test(String(url || ""));
}

function normalizeResponse(response, operationId, phase) {
  if (!response) {
    throw { phase, error: "GPT 页面没有响应", diagnostics: { operationId } };
  }
  if (response.operationId && response.operationId !== operationId) {
    throw {
      phase,
      error: "GPT 返回的 operationId 不匹配，已阻止旧任务串线。",
      diagnostics: { expected: operationId, actual: response.operationId }
    };
  }
  if (!response.ok) {
    throw {
      phase: response.phase || phase,
      error: response.error || "GPT 页面执行失败",
      diagnostics: response.diagnostics || null
    };
  }
  return response;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT]
    });
  } catch {
    await sendToTab(tabId, { type: "ping" }, 1500);
  }
}

async function waitForContentReady(tabId) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    try {
      const response = await sendToTab(tabId, { type: "ping" }, 1500);
      if (response && response.ok) return;
    } catch {
      await delay(500);
    }
  }
  throw { phase: "inject", error: "GPT 页面脚本未就绪。", diagnostics: { tabId } };
}

function sendToTab(tabId, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject({
      phase: message.type === "gpt:execute" ? "execute" : "plan",
      error: "页面响应超时",
      diagnostics: { tabId, operationId: message.operationId || "" }
    }), timeoutMs || (message.timeoutMs || 30000) + 15000);

    chrome.tabs.sendMessage(tabId, message, (response) => {
      clearTimeout(timer);
      const error = chrome.runtime.lastError;
      if (error) {
        reject({
          phase: "message",
          error: error.message,
          diagnostics: { tabId, operationId: message.operationId || "" }
        });
        return;
      }
      resolve(response);
    });
  });
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, 15000);

    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        done();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || tab?.status === "complete") {
        done();
      }
    });
  });
}

async function safeGetTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (error) {
    throw { phase: "tab", error: `GPT 标签页不可用，请重新打开 GPT：${error.message || error}`, diagnostics: { tabId } };
  }
}

async function safeUpdateTab(tabId, updateInfo) {
  try {
    return await chrome.tabs.update(tabId, updateInfo);
  } catch (error) {
    throw { phase: "tab", error: `GPT 标签页已关闭或不可用，请重新打开 GPT：${error.message || error}`, diagnostics: { tabId } };
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
