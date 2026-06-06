const STORAGE_DEFAULTS = {
  enabled: true,
  detailTabId: null,
  sourceTabId: null,
  lastDetailUrl: null,
  onboardingDone: false
};

const TEMU_SPLIT_MESSAGE_TYPES = new Set([
  "TEMU_SPLIT_GET_STATUS",
  "TEMU_SPLIT_SET_ENABLED",
  "TEMU_SPLIT_OPEN_DETAIL_IN_RIGHT_TAB",
  "TEMU_SPLIT_EXPECT_NATURAL_DETAIL_TAB",
  "TEMU_SPLIT_FOCUS_DETAIL_TAB",
  "TEMU_SPLIT_BIND_SOURCE_TAB",
  "TEMU_SPLIT_BIND_DETAIL_TAB",
  "TEMU_SPLIT_CLEAR_DETAIL_RECORD"
]);

const NATURAL_DETAIL_WAIT_MS = 9000;
const pendingNaturalClicks = new Map();
const candidateNaturalTabs = new Map();

function storageGet() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(STORAGE_DEFAULTS, (items) => resolve(items));
  });
}

function storageSet(values) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(values, () => resolve());
  });
}

function tabGet(tabId) {
  if (!Number.isInteger(tabId)) return Promise.resolve(null);

  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      resolve(chrome.runtime.lastError ? null : tab);
    });
  });
}

function tabUpdate(tabId, updateProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, updateProperties, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tab);
    });
  });
}

function tabCreate(createProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(createProperties, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tab);
    });
  });
}

function tabRemove(tabId) {
  if (!Number.isInteger(tabId)) return Promise.resolve();

  return new Promise((resolve) => {
    chrome.tabs.remove(tabId, () => resolve());
  });
}

function tabGoBack(tabId) {
  if (!Number.isInteger(tabId) || !chrome.tabs.goBack) return Promise.resolve(false);

  return new Promise((resolve) => {
    chrome.tabs.goBack(tabId, () => {
      resolve(!chrome.runtime.lastError);
    });
  });
}

function tabQuery(queryInfo) {
  return new Promise((resolve) => {
    chrome.tabs.query(queryInfo, (tabs) => resolve(tabs || []));
  });
}

function focusWindow(windowId) {
  return new Promise((resolve) => {
    chrome.windows.update(windowId, { focused: true }, () => resolve());
  });
}

function sendMessageToTab(tabId, message) {
  if (!Number.isInteger(tabId)) return;
  chrome.tabs.sendMessage(tabId, message, () => {
    // The content script may not be present on non-Temu pages or old tabs.
    void chrome.runtime.lastError;
  });
}

function isTemuUrl(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === "temu.com" || hostname.endsWith(".temu.com");
  } catch {
    return false;
  }
}

function isProductDetailUrl(url) {
  try {
    const parsed = new URL(url);
    if (!isTemuUrl(parsed.href)) return false;

    const path = parsed.pathname.toLowerCase();
    const params = parsed.searchParams;

    return (
      path.includes("/product/") ||
      path.includes("/item/") ||
      path.includes("/goods/") ||
      path.endsWith("/goods.html") ||
      /-g-\d+\.html$/.test(path) ||
      params.has("goods_id") ||
      params.has("product_id") ||
      params.has("item_id")
    );
  } catch {
    return false;
  }
}

function isBlankLikeUrl(url) {
  const value = String(url || "").trim().toLowerCase();
  return !value || value === "about:blank";
}

function getSplitViewId(tab) {
  if (!tab || typeof tab.splitViewId === "undefined") return null;
  return Number.isInteger(tab.splitViewId) && tab.splitViewId >= 0 ? tab.splitViewId : null;
}

function hasSplitViewField(tab) {
  return Boolean(tab && typeof tab.splitViewId !== "undefined");
}

async function createDetailTab(url, sourceTab, active = false) {
  const createProperties = {
    url,
    active
  };

  if (sourceTab?.windowId !== undefined) {
    createProperties.windowId = sourceTab.windowId;
  }

  if (Number.isInteger(sourceTab?.index)) {
    createProperties.index = sourceTab.index + 1;
  }

  return tabCreate(createProperties);
}

function rememberNaturalDetailExpectation(sourceTab) {
  if (!sourceTab?.id) return;

  pendingNaturalClicks.set(sourceTab.id, {
    sourceTabId: sourceTab.id,
    windowId: sourceTab.windowId,
    sourceUrl: sourceTab.url || null,
    createdAt: Date.now()
  });
}

function cleanupNaturalDetailTracking() {
  const now = Date.now();

  for (const [sourceTabId, pending] of pendingNaturalClicks) {
    if (now - pending.createdAt > NATURAL_DETAIL_WAIT_MS) {
      pendingNaturalClicks.delete(sourceTabId);
    }
  }

  for (const [tabId, candidate] of candidateNaturalTabs) {
    if (now - candidate.createdAt > NATURAL_DETAIL_WAIT_MS) {
      candidateNaturalTabs.delete(tabId);
    }
  }
}

function scheduleBlankCandidateCleanup(tabId) {
  setTimeout(async () => {
    const candidate = candidateNaturalTabs.get(tabId);
    if (!candidate) return;

    const tab = await tabGet(tabId);
    if (tab && isBlankLikeUrl(tab.url)) {
      await tabRemove(tabId);
      candidateNaturalTabs.delete(tabId);
    }
  }, NATURAL_DETAIL_WAIT_MS + 500);
}

function findPendingNaturalClickForTab(tab) {
  cleanupNaturalDetailTracking();

  if (tab?.openerTabId && pendingNaturalClicks.has(tab.openerTabId)) {
    return pendingNaturalClicks.get(tab.openerTabId);
  }

  for (const pending of pendingNaturalClicks.values()) {
    if (pending.windowId === tab?.windowId) return pending;
  }

  return null;
}

async function handleNaturalDetailTab(tab) {
  if (!tab?.id || !tab.url || !isProductDetailUrl(tab.url)) return false;

  const candidate = candidateNaturalTabs.get(tab.id) || findPendingNaturalClickForTab(tab);
  if (!candidate) return false;

  const state = await storageGet();
  if (!state.enabled) return false;

  const sourceTab = await tabGet(candidate.sourceTabId);
  if (!sourceTab) return false;

  let detailTab = await findManagedDetailTab(state, sourceTab);

  if (tab.id === sourceTab.id) {
    if (detailTab && detailTab.id !== sourceTab.id) {
      await tabUpdate(detailTab.id, { url: tab.url });
      await storageSet({
        sourceTabId: sourceTab.id,
        detailTabId: detailTab.id,
        lastDetailUrl: tab.url
      });

      const wentBack = await tabGoBack(sourceTab.id);
      if (!wentBack && candidate.sourceUrl && candidate.sourceUrl !== tab.url) {
        await tabUpdate(sourceTab.id, { url: candidate.sourceUrl });
      }

      sendMessageToTab(sourceTab.id, {
        type: "SHOW_TOAST",
        variant: "success",
        text: "已把详情页送到右侧，并恢复左侧列表。"
      });

      candidateNaturalTabs.delete(tab.id);
      pendingNaturalClicks.delete(sourceTab.id);
      return true;
    }

    const createdDetailTab = await createDetailTab(tab.url, sourceTab, false);
    await storageSet({
      sourceTabId: sourceTab.id,
      detailTabId: createdDetailTab.id,
      lastDetailUrl: tab.url
    });

    const wentBack = await tabGoBack(sourceTab.id);
    if (!wentBack && candidate.sourceUrl && candidate.sourceUrl !== tab.url) {
      await tabUpdate(sourceTab.id, { url: candidate.sourceUrl });
    }

    candidateNaturalTabs.delete(tab.id);
    pendingNaturalClicks.delete(sourceTab.id);
    return true;
  }

  if (!detailTab || detailTab.id === tab.id) {
    await storageSet({
      sourceTabId: sourceTab.id,
      detailTabId: tab.id,
      lastDetailUrl: tab.url
    });
    candidateNaturalTabs.delete(tab.id);
    pendingNaturalClicks.delete(sourceTab.id);
    return true;
  }

  await tabUpdate(detailTab.id, { url: tab.url });
  await storageSet({
    sourceTabId: sourceTab.id,
    detailTabId: detailTab.id,
    lastDetailUrl: tab.url
  });

  if (tab.id !== sourceTab.id && tab.id !== detailTab.id) {
    await tabRemove(tab.id);
  }

  sendMessageToTab(sourceTab.id, {
    type: "SHOW_TOAST",
    variant: "success",
    text: "已把真实详情页更新到右侧标签。"
  });

  candidateNaturalTabs.delete(tab.id);
  pendingNaturalClicks.delete(sourceTab.id);
  return true;
}

async function findSplitMateTab(tab, predicate) {
  const splitViewId = getSplitViewId(tab);
  if (splitViewId === null || tab?.windowId === undefined) return null;

  const tabs = await tabQuery({ windowId: tab.windowId });
  return tabs.find((candidate) => {
    return candidate.id !== tab.id && getSplitViewId(candidate) === splitViewId && predicate(candidate);
  }) || null;
}

async function findManagedDetailTab(state, sourceTab) {
  const splitDetailTab = await findSplitMateTab(sourceTab, (candidate) => {
    return Boolean(candidate.url && isProductDetailUrl(candidate.url));
  });

  if (splitDetailTab) return splitDetailTab;

  const storedDetailTab = await tabGet(state.detailTabId);
  if (storedDetailTab && storedDetailTab.id !== sourceTab?.id) {
    return storedDetailTab;
  }

  if (state.lastDetailUrl && sourceTab?.windowId !== undefined) {
    const tabs = await tabQuery({ windowId: sourceTab.windowId });
    return tabs.find((candidate) => {
      return candidate.id !== sourceTab.id && candidate.url && isProductDetailUrl(candidate.url);
    }) || null;
  }

  return null;
}

async function findSplitSourceTab(detailTab) {
  return findSplitMateTab(detailTab, (candidate) => {
    return Boolean(candidate.url && isTemuUrl(candidate.url) && !isProductDetailUrl(candidate.url));
  });
}

async function openDetailInManagedTab(url, sourceTab) {
  if (!isProductDetailUrl(url)) {
    throw new Error("这不是 Temu 商品详情链接。");
  }

  const state = await storageGet();
  if (!state.enabled) {
    return { opened: false, reason: "disabled" };
  }

  let detailTab = await findManagedDetailTab(state, sourceTab);

  if (detailTab) {
    detailTab = await tabUpdate(detailTab.id, { url });
  } else {
    detailTab = await createDetailTab(url, sourceTab, false);
  }

  await storageSet({
    sourceTabId: sourceTab?.id ?? state.sourceTabId,
    detailTabId: detailTab.id,
    lastDetailUrl: url
  });

  if (!state.onboardingDone && sourceTab?.id !== undefined) {
    sendMessageToTab(sourceTab.id, {
      type: "SHOW_TOAST",
      variant: "onboarding",
      text: "详情标签已打开。首次使用请把列表标签和详情标签加入 Chrome 原生分屏，之后点击商品会复用右侧详情标签。"
    });
    await storageSet({ onboardingDone: true });
  } else if (sourceTab?.id !== undefined) {
    sendMessageToTab(sourceTab.id, {
      type: "SHOW_TOAST",
      variant: "success",
      text: "已更新详情标签。"
    });
  }

  return { opened: true, detailTabId: detailTab.id };
}

async function getStatus(currentTabId = null) {
  const state = await storageGet();
  const detailTab = await tabGet(state.detailTabId);
  const sourceTab = await tabGet(state.sourceTabId);
  const currentTab = await tabGet(currentTabId);
  const sourceSplitViewId = getSplitViewId(sourceTab);
  const detailSplitViewId = getSplitViewId(detailTab);
  const splitViewSupported = hasSplitViewField(sourceTab) || hasSplitViewField(detailTab) || hasSplitViewField(currentTab);

  return {
    enabled: state.enabled,
    detailTabId: detailTab?.id ?? null,
    sourceTabId: sourceTab?.id ?? null,
    lastDetailUrl: state.lastDetailUrl,
    onboardingDone: state.onboardingDone,
    hasDetailTab: Boolean(detailTab),
    hasSourceTab: Boolean(sourceTab),
    currentIsTemu: Boolean(currentTab?.url && isTemuUrl(currentTab.url)),
    splitViewSupported,
    sourceSplitViewId,
    detailSplitViewId,
    sameSplitView: sourceSplitViewId !== null && detailSplitViewId !== null && sourceSplitViewId === detailSplitViewId
  };
}

async function notifyTemuTabsStatusChanged(enabled) {
  const tabs = await tabQuery({
    url: ["*://temu.com/*", "*://*.temu.com/*"]
  });

  for (const tab of tabs) {
    sendMessageToTab(tab.id, {
      type: "STATUS_CHANGED",
      enabled
    });
    sendMessageToTab(tab.id, {
      type: "SHOW_TOAST",
      variant: enabled ? "success" : "onboarding",
      text: enabled ? "Temu 商品点击拦截已开启（Alt+W 可关闭）。" : "Temu 商品点击拦截已关闭（Alt+W 可开启）。"
    });
  }
}

async function toggleEnabledByCommand() {
  const state = await storageGet();
  const enabled = !state.enabled;
  await storageSet({ enabled });
  await notifyTemuTabsStatusChanged(enabled);
}

async function focusDetailTab() {
  const state = await storageGet();
  let detailTab = await tabGet(state.detailTabId);

  if (!detailTab && state.lastDetailUrl) {
    const sourceTab = await tabGet(state.sourceTabId);
    detailTab = await createDetailTab(state.lastDetailUrl, sourceTab, true);
    await storageSet({ detailTabId: detailTab.id });
  }

  if (!detailTab) {
    throw new Error("还没有详情标签。请先在 Temu 列表页点击一个商品。");
  }

  await tabUpdate(detailTab.id, { active: true });
  await focusWindow(detailTab.windowId);
  return { detailTabId: detailTab.id };
}

async function bindSourceTab(tabId) {
  const tab = await tabGet(tabId);
  if (!tab?.url || !isTemuUrl(tab.url)) {
    throw new Error("当前标签不是 Temu 页面，不能绑定为列表页。");
  }

  await storageSet({ sourceTabId: tab.id });
  return { sourceTabId: tab.id };
}

async function bindDetailTab(tabId) {
  const tab = await tabGet(tabId);
  if (!tab?.url || !isProductDetailUrl(tab.url)) {
    throw new Error("当前标签不是 Temu 商品详情页，不能绑定为详情标签。");
  }

  const sourceTab = await findSplitSourceTab(tab);
  await storageSet({
    detailTabId: tab.id,
    lastDetailUrl: tab.url,
    sourceTabId: sourceTab?.id ?? (await storageGet()).sourceTabId
  });

  return {
    detailTabId: tab.id,
    sourceTabId: sourceTab?.id ?? null
  };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(Object.keys(STORAGE_DEFAULTS), (items) => {
    const missingDefaults = {};
    for (const [key, value] of Object.entries(STORAGE_DEFAULTS)) {
      if (typeof items[key] === "undefined") missingDefaults[key] = value;
    }
    if (Object.keys(missingDefaults).length > 0) {
      chrome.storage.sync.set(missingDefaults);
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  candidateNaturalTabs.delete(tabId);
  pendingNaturalClicks.delete(tabId);

  storageGet().then((state) => {
    const updates = {};
    if (state.detailTabId === tabId) updates.detailTabId = null;
    if (state.sourceTabId === tabId) updates.sourceTabId = null;
    if (Object.keys(updates).length > 0) storageSet(updates);
  });
});

chrome.tabs.onCreated.addListener((tab) => {
  const pending = findPendingNaturalClickForTab(tab);
  if (!pending) return;

  candidateNaturalTabs.set(tab.id, {
    sourceTabId: pending.sourceTabId,
    sourceUrl: pending.sourceUrl || null,
    createdAt: Date.now()
  });
  scheduleBlankCandidateCleanup(tab.id);

  if (tab.active) {
    tabUpdate(pending.sourceTabId, { active: true }).catch(() => {});
  }

  if (tab.url && isProductDetailUrl(tab.url)) {
    handleNaturalDetailTab(tab);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!candidateNaturalTabs.has(tabId) && !findPendingNaturalClickForTab(tab)) return;

  if (!candidateNaturalTabs.has(tabId)) {
    const pending = findPendingNaturalClickForTab(tab);
    candidateNaturalTabs.set(tabId, {
      sourceTabId: pending.sourceTabId,
      sourceUrl: pending.sourceUrl || null,
      createdAt: Date.now()
    });
  }

  const url = changeInfo.url || tab.url;
  if (url && isProductDetailUrl(url)) {
    handleNaturalDetailTab({ ...tab, url });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!TEMU_SPLIT_MESSAGE_TYPES.has(message?.type)) {
    return false;
  }

  (async () => {
    switch (message?.type) {
      case "TEMU_SPLIT_GET_STATUS": {
        const status = await getStatus(message.currentTabId ?? sender.tab?.id ?? null);
        sendResponse({ ok: true, status });
        break;
      }

      case "TEMU_SPLIT_SET_ENABLED": {
        const enabled = Boolean(message.enabled);
        await storageSet({ enabled });
        await notifyTemuTabsStatusChanged(enabled);
        sendResponse({ ok: true, status: await getStatus(message.currentTabId ?? null) });
        break;
      }

      case "TEMU_SPLIT_OPEN_DETAIL_IN_RIGHT_TAB": {
        const result = await openDetailInManagedTab(message.url, sender.tab);
        sendResponse({ ok: true, ...result });
        break;
      }

      case "TEMU_SPLIT_EXPECT_NATURAL_DETAIL_TAB": {
        const state = await storageGet();
        if (state.enabled && sender.tab?.id) {
          rememberNaturalDetailExpectation(sender.tab);
          await storageSet({ sourceTabId: sender.tab.id });
        }
        sendResponse({ ok: true });
        break;
      }

      case "TEMU_SPLIT_FOCUS_DETAIL_TAB": {
        const result = await focusDetailTab();
        sendResponse({ ok: true, ...result, status: await getStatus(message.currentTabId ?? null) });
        break;
      }

      case "TEMU_SPLIT_BIND_SOURCE_TAB": {
        const result = await bindSourceTab(message.tabId);
        sendResponse({ ok: true, ...result, status: await getStatus(message.tabId) });
        break;
      }

      case "TEMU_SPLIT_BIND_DETAIL_TAB": {
        const result = await bindDetailTab(message.tabId);
        sendResponse({ ok: true, ...result, status: await getStatus(message.tabId) });
        break;
      }

      case "TEMU_SPLIT_CLEAR_DETAIL_RECORD": {
        await storageSet({ detailTabId: null, lastDetailUrl: null });
        sendResponse({ ok: true, status: await getStatus(message.currentTabId ?? null) });
        break;
      }

      default:
        return;
    }
  })().catch((error) => {
    sendResponse({ ok: false, error: error.message || String(error) });
  });

  return true;
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "toggle-temu-split") return;
  toggleEnabledByCommand();
});
