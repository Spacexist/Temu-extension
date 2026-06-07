import { readRowsFromBrowserFile } from "../../infrastructure/xlsx/browserXlsxSheetIO.js";
import { importTemplateMainImages } from "../../application/usecases/importTemplateMainImages.js";
import { createChatgptClient, isChatgptUrl as isChatgptAutomationUrl } from "./chatgptClient.js";
import { downloadImageData } from "./downloadClient.js";
import {
  STAGES,
  getQueueItemNumber as getQueueSequenceNumber,
  isActiveStage as isQueueActiveStage,
  isTerminalStage as isQueueTerminalStage,
  isTimeoutError as isQueueTimeoutError,
  makeOperationId,
  markItemFailed,
  resetItemForFullRetry,
  shouldRestartFromPlanAfterTimeout as shouldRestartQueueItemAfterTimeout,
  stageLabel as resolveStageLabel
} from "./queueEngine.js";

const DEFAULT_PLAN_PROMPT = "请先观察这张图片，规划如何把它修改为 Temu 主图。目标市场是美国。要求：不要文字、不要水印、不要违规、不要夸大商品功能、突出商品主体、背景干净、适合作为电商主图。先只输出修改规划，不要生成图片。";
const DEFAULT_EXECUTE_PROMPT = "请按照上一步规划执行图片修改，生成最终 Temu 美国站主图。不要文字，不要水印，不要违规，保持商品真实，背景干净，突出商品主体。";
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);
const MAX_QUEUE_IMAGES = 500;
const GPT_TAB_LOCK_KEY = "temuGptLockedTabId";
const DASHBOARD_STATE_KEY = "temuGptDashboardState";

const state = {
  instanceId: makeInstanceId(),
  items: [],
  running: false,
  processing: false,
  paused: false,
  stopRequested: false,
  activeIndex: -1,
  gptTabId: null,
  importSummary: "等待导入。",
  canPublishDashboardState: false,
  syncingDashboardState: false,
  sourceDownloadFailedListings: [],
  log: []
};

let settingsSaveTimer = null;
const chatgptClient = createChatgptClient({
  getLockedTabId: () => state.gptTabId,
  setLockedTabId: setLockedGptTabId
});

const els = {
  openChatgpt: document.getElementById("openChatgpt"),
  selectFolder: document.getElementById("selectFolder"),
  importTemplate: document.getElementById("importTemplate"),
  folderInput: document.getElementById("folderInput"),
  templateInput: document.getElementById("templateInput"),
  startBtn: document.getElementById("startBtn"),
  pauseBtn: document.getElementById("pauseBtn"),
  resumeBtn: document.getElementById("resumeBtn"),
  stopBtn: document.getElementById("stopBtn"),
  exportLogBtn: document.getElementById("exportLogBtn"),
  clearBtn: document.getElementById("clearBtn"),
  startFromIndex: document.getElementById("startFromIndex"),
  taskTimeout: document.getElementById("taskTimeout"),
  outputSuffix: document.getElementById("outputSuffix"),
  planPrompt: document.getElementById("planPrompt"),
  executePrompt: document.getElementById("executePrompt"),
  importSummary: document.getElementById("importSummary"),
  totalCount: document.getElementById("totalCount"),
  successCount: document.getElementById("successCount"),
  failedCount: document.getElementById("failedCount"),
  remainingCount: document.getElementById("remainingCount"),
  currentFile: document.getElementById("currentFile"),
  currentStage: document.getElementById("currentStage"),
  currentSequence: document.getElementById("currentSequence"),
  progressFill: document.getElementById("progressFill"),
  planPreview: document.getElementById("planPreview"),
  log: document.getElementById("log")
};

init();

async function init() {
  const saved = await chrome.storage.local.get(["planPrompt", "executePrompt", "taskTimeout", "planTimeout", "executeTimeout", "outputSuffix", "startFromIndex", GPT_TAB_LOCK_KEY, DASHBOARD_STATE_KEY]);
  state.gptTabId = Number(saved[GPT_TAB_LOCK_KEY]) || null;
  restoreDashboardSnapshot(saved[DASHBOARD_STATE_KEY]);
  els.planPrompt.value = saved.planPrompt || DEFAULT_PLAN_PROMPT;
  els.executePrompt.value = saved.executePrompt || DEFAULT_EXECUTE_PROMPT;
  els.startFromIndex.value = saved.startFromIndex || 1;
  els.taskTimeout.value = saved.taskTimeout || saved.executeTimeout || saved.planTimeout || 420;
  els.outputSuffix.value = saved.outputSuffix || "_temu_main";

  for (const input of [els.planPrompt, els.executePrompt, els.taskTimeout, els.outputSuffix]) {
    input.addEventListener("change", saveSettings);
  }
  for (const input of [els.planPrompt, els.executePrompt]) {
    input.addEventListener("input", scheduleSaveSettings);
  }
  els.startFromIndex.addEventListener("change", handleStartFromIndexChange);

  els.openChatgpt.addEventListener("click", () => {
    chatgptClient.openChatgptTab().catch((error) => {
      addLog("bad", `打开 GPT 失败：${error.message || error}`);
      render();
    });
  });
  els.selectFolder.addEventListener("click", chooseFolderSafely);
  els.folderInput.addEventListener("change", loadFolder);
  els.importTemplate.addEventListener("click", () => els.templateInput.click());
  els.templateInput.addEventListener("change", loadTemplateWorkbook);
  els.startBtn.addEventListener("click", startQueue);
  els.pauseBtn.addEventListener("click", pauseQueue);
  els.resumeBtn.addEventListener("click", resumeQueue);
  els.stopBtn.addEventListener("click", stopQueue);
  els.clearBtn.addEventListener("click", clearQueue);
  els.exportLogBtn.addEventListener("click", exportLog);
  chrome.storage.onChanged.addListener(handleStorageChanged);
  chrome.tabs.onRemoved.addListener(handleTabRemoved);
  chrome.tabs.onUpdated.addListener(handleTabUpdated);
  render();
}

function handleStorageChanged(changes, areaName) {
  if (areaName !== "local") return;

  if (changes[GPT_TAB_LOCK_KEY]) {
    state.gptTabId = Number(changes[GPT_TAB_LOCK_KEY].newValue) || null;
  }

  if (changes[DASHBOARD_STATE_KEY]) {
    const snapshot = changes[DASHBOARD_STATE_KEY].newValue;
    if (!snapshot || snapshot.instanceId === state.instanceId) return;
    state.syncingDashboardState = true;
    restoreDashboardSnapshot(snapshot);
    render();
    state.syncingDashboardState = false;
  }
}

function handleTabRemoved(tabId) {
  if (tabId !== state.gptTabId) return;
  setLockedGptTabId(null).catch(() => {});
}

function handleTabUpdated(tabId, changeInfo) {
  if (tabId !== state.gptTabId || typeof changeInfo.url !== "string") return;
  if (!isChatgptAutomationUrl(changeInfo.url)) {
    setLockedGptTabId(null).catch(() => {});
  }
}

async function saveSettings() {
  const taskTimeout = Number(els.taskTimeout.value) || 420;
  await chrome.storage.local.set({
    planPrompt: els.planPrompt.value.trim() || DEFAULT_PLAN_PROMPT,
    executePrompt: els.executePrompt.value.trim() || DEFAULT_EXECUTE_PROMPT,
    startFromIndex: normalizeStartFromIndex(),
    taskTimeout,
    planTimeout: taskTimeout,
    executeTimeout: taskTimeout,
    outputSuffix: els.outputSuffix.value.trim() || "_temu_main"
  });
}

function scheduleSaveSettings() {
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    saveSettings().catch((error) => {
      addLog("bad", `保存指令失败：${error.message || error}`);
      render();
    });
  }, 250);
}

async function getLiveSettings() {
  await saveSettings();
  const taskTimeout = Number(els.taskTimeout.value) || 420;
  return {
    planPrompt: els.planPrompt.value.trim() || DEFAULT_PLAN_PROMPT,
    executePrompt: els.executePrompt.value.trim() || DEFAULT_EXECUTE_PROMPT,
    taskTimeout
  };
}

async function handleStartFromIndexChange() {
  await saveSettings();

  if (state.running || state.paused) {
    applyStartFromIndex();
    addLog("info", `已更新起始位置：从第 ${normalizeStartFromIndex()} 个开始，未处理队列将按新位置继续。`);
    render();
  }
}

async function chooseFolderSafely() {
  if ("showDirectoryPicker" in window) {
    await loadDirectoryWithPicker();
    return;
  }

  addLog("info", "当前浏览器不支持安全文件夹选择，改用多文件选择。");
  els.folderInput.click();
}

async function loadDirectoryWithPicker() {
  try {
    enableDashboardPublishing();
    const rootHandle = await window.showDirectoryPicker({ mode: "read" });
    const items = [];
    let truncated = false;
    addLog("info", "正在扫描图片文件，请稍等。");
    render();

    for await (const entry of walkDirectory(rootHandle)) {
      if (!IMAGE_EXTENSIONS.has(getExtension(entry.name))) continue;
      items.push(makeQueueItem({
        id: `${Date.now()}-${items.length}`,
        file: null,
        handle: entry.handle,
        name: entry.name,
        path: entry.path,
        sequenceNumber: extractLeadingSequenceNumber(entry.name) || 0,
        localCachePath: entry.path
      }));

      if (items.length >= MAX_QUEUE_IMAGES) {
        truncated = true;
        break;
      }
    }

    items.sort(compareQueueItemsBySequenceThenPath);
    resetQueue(items);
    state.importSummary = `图片文件夹：已载入 ${state.items.length} 张图片。`;
    if (truncated) {
      addLog("bad", `图片数量超过 ${MAX_QUEUE_IMAGES} 张，已只载入前 ${MAX_QUEUE_IMAGES} 张，避免浏览器崩溃。`);
    }
    addLog("info", `已安全载入 ${state.items.length} 张图片。`);
    render();
  } catch (error) {
    if (error && error.name === "AbortError") {
      addLog("info", "已取消选择文件夹。");
    } else {
      addLog("bad", `文件夹选择失败：${error.message || error}`);
    }
    render();
  }
}

async function* walkDirectory(directoryHandle, prefix = "") {
  let scanned = 0;
  for await (const [name, handle] of directoryHandle.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "file") {
      yield { name, path, handle };
    } else if (handle.kind === "directory") {
      yield* walkDirectory(handle, path);
    }

    scanned += 1;
    if (scanned % 25 === 0) {
      await delay(0);
    }
  }
}

function loadFolder(event) {
  enableDashboardPublishing();
  const files = Array.from(event.target.files || [])
    .filter((file) => IMAGE_EXTENSIONS.has(getExtension(file.name)))
    .slice(0, MAX_QUEUE_IMAGES)
    .sort(compareQueueLikeFiles);

  const items = files.map((file, index) => makeQueueItem({
    id: `${Date.now()}-${index}`,
    file,
    handle: null,
    name: file.name,
    path: getDisplayPath(file),
    sequenceNumber: extractLeadingSequenceNumber(file.name) || 0,
    localCachePath: getDisplayPath(file)
  }));
  resetQueue(items);
  state.importSummary = `图片文件：已载入 ${state.items.length} 张图片。`;
  addLog("info", `已载入 ${state.items.length} 张图片。`);
  render();
}

async function loadTemplateWorkbook(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    enableDashboardPublishing();
    state.sourceDownloadFailedListings = [];
    addLog("info", `正在读取模板 Excel：${file.name}`);
    render();

    const rows = await readRowsFromBrowserFile(file);
    const result = importTemplateMainImages(rows, {
      idPrefix: `template-${Date.now()}`
    });

    const items = result.items
      .slice(0, MAX_QUEUE_IMAGES)
      .map((item) => makeQueueItem({
        id: item.id,
        file: null,
        handle: null,
        name: item.name,
        path: `${file.name} 第 ${item.rowNumber} 行`,
        remoteUrl: item.imageUrl,
        uploadName: item.uploadName,
        meta: {
          sourceColumn: item.sourceColumn,
          sourceName: item.sourceName,
          sourceNameHash: item.sourceNameHash,
          identifier: item.identifier,
          title: item.title,
          rowNumber: item.rowNumber
        }
      }));

    if (!items.length) {
      throw new Error("模板中没有识别到可用的首张轮播图链接");
    }

    resetQueue(items);
    state.importSummary = `模板 Excel：扫描 ${result.summary.rowsScanned} 行，去重后 ${items.length} 张，A 列重复跳过 ${result.summary.duplicateNameRowCount} 行。`;
    render();
    await cacheRemoteImagesForQueue(state.items, file.name);

    if (result.items.length > MAX_QUEUE_IMAGES) {
      addLog("bad", `模板中识别到 ${result.items.length} 张图片，已只载入前 ${MAX_QUEUE_IMAGES} 张。`);
    }

    addLog(
      "info",
      `模板导入完成：使用 ${result.summary.primaryImageColumn || result.summary.fallbackImageColumn}，共提取 ${items.length} 张首图，按 A 列名称去重跳过 ${result.summary.duplicateNameRowCount} 行。`
    );
  } catch (error) {
    addLog("bad", `模板导入失败：${error.message || error}`);
  } finally {
    els.templateInput.value = "";
    render();
  }
}

async function cacheRemoteImagesForQueue(items, templateName) {
  if (!items.length) return;

  if (!("showDirectoryPicker" in window)) {
    addLog("bad", "当前浏览器不支持选择本地缓存目录，Excel URL 图片将保留为运行时下载。");
    return;
  }

  let rootHandle = null;
  try {
    addLog("info", "请选择 Excel URL 图片缓存目录，插件会在里面新建子文件夹。");
    render();
    rootHandle = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch (error) {
    if (error?.name === "AbortError") {
      addLog("bad", "已取消选择缓存目录，Excel URL 图片将保留为运行时下载。");
      return;
    }
    throw error;
  }

  const cacheFolderName = buildCacheFolderName(templateName);
  const cacheHandle = await rootHandle.getDirectoryHandle(cacheFolderName, { create: true });
  let cachedCount = 0;
  let failedCount = 0;

  for (const item of items) {
    const sequenceNumber = getQueueItemNumber(item);
    try {
      item.stage = STAGES.FETCHING_SOURCE;
      addLog("info", `第 ${sequenceNumber} 个 缓存 Excel 图片 URL：${item.name}`);
      render();

      const file = await fetchRemoteImageAsFile(item);
      const numberedFileName = buildNumberedSourceFilename(sequenceNumber, items.length, file.name);
      const cachedFile = new File([file], numberedFileName, { type: file.type || guessMime(numberedFileName) });
      const fileHandle = await cacheHandle.getFileHandle(numberedFileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(cachedFile);
      await writable.close();

      item.file = null;
      item.handle = fileHandle;
      item.name = numberedFileName;
      item.localCachePath = `${cacheFolderName}/${numberedFileName}`;
      item.stage = STAGES.PENDING_PLAN;
      item.error = "";
      item.failedPhase = "";
      item.failedSequenceNumber = 0;
      item.diagnostics = null;
      cachedCount += 1;
      addLog("ok", `第 ${sequenceNumber} 个 已缓存：${item.localCachePath}`);
    } catch (error) {
      failedCount += 1;
      const failedEntry = {
        sequenceNumber,
        listing: item.name,
        rowNumber: item.meta?.rowNumber || "",
        remoteUrl: item.remoteUrl || "",
        failedPhase: "fetching_source",
        error: `Excel URL 图片缓存失败：${error.message || error}`
      };
      state.sourceDownloadFailedListings.push(failedEntry);
      markItemFailed(item, {
        phase: "fetching_source",
        error: `Excel URL 图片缓存失败：${error.message || error}`,
        diagnostics: makeItemDiagnostics(item)
      }, items);
      addLog("bad", `第 ${sequenceNumber} 个失败：phase=fetching_source，Excel URL 图片缓存失败。`);
    }
  }

  state.importSummary += ` 本地缓存：成功 ${cachedCount} 张，失败 ${failedCount} 张，目录 ${cacheFolderName}。请点击“选择图片文件夹”载入这个子文件夹后再开始。`;
  addLog("info", `Excel URL 图片缓存完成：成功 ${cachedCount}，失败 ${failedCount}。下一步请点“选择图片文件夹”选择 ${cacheFolderName}。`);
  render();
}

function resetQueue(items) {
  state.items = items.map((item, index) => ({
    ...item,
    sequenceNumber: Number(item.sequenceNumber) || index + 1
  }));
  state.running = false;
  state.paused = false;
  state.stopRequested = false;
  state.activeIndex = -1;
  state.log = [];
}

function makeQueueItem({ id, file, handle, name, path, remoteUrl = "", uploadName = "", localCachePath = "", meta = null }) {
  return {
    id,
    file,
    handle,
    name,
    path,
    remoteUrl,
    uploadName,
    localCachePath,
    meta,
    stage: STAGES.PENDING_PLAN,
    attempts: { plan: 0, execute: 0, download: 0 },
    timeoutRestarted: false,
    failedSequenceNumber: 0,
    failedPhase: "",
    diagnostics: null,
    planText: "",
    error: ""
  };
}

async function startQueue() {
  if (!state.items.length || state.running) return;
  enableDashboardPublishing();
  applyStartFromIndex();
  state.running = true;
  state.paused = false;
  state.stopRequested = false;
  await saveSettings();
  render();
  processQueue();
}

function pauseQueue() {
  enableDashboardPublishing();
  state.paused = true;
  addLog("info", "已请求暂停，当前图片处理完或失败后暂停。");
  render();
}

function resumeQueue() {
  if (!state.items.length) return;
  enableDashboardPublishing();
  state.paused = false;
  state.running = true;
  state.stopRequested = false;
  addLog("info", "继续队列。");
  render();
  if (!state.processing) {
    processQueue();
  }
}

async function stopQueue() {
  enableDashboardPublishing();
  state.stopRequested = true;
  state.running = false;
  state.paused = false;
  addLog("bad", "已请求停止，正在中断 GPT 当前生成。");
  render();

  try {
    await chatgptClient.stop();
  } catch (error) {
    addLog("bad", `停止 GPT 生成时未收到确认：${error.message || error}`);
  }
  render();
}

function clearQueue() {
  if (state.processing) return;
  enableDashboardPublishing();
  state.items = [];
  state.running = false;
  state.processing = false;
  state.paused = false;
  state.stopRequested = false;
  state.activeIndex = -1;
  state.importSummary = "等待导入。";
  state.sourceDownloadFailedListings = [];
  state.log = [];
  els.folderInput.value = "";
  els.templateInput.value = "";
  render();
}

async function processQueue() {
  if (state.processing) return;

  state.processing = true;
  try {
    while (state.running && !state.paused && !state.stopRequested) {
      const nextIndex = state.items.findIndex((item) => !isQueueTerminalStage(item.stage));
      if (nextIndex === -1) {
        state.running = false;
        state.activeIndex = -1;
        addLog("ok", "队列完成。");
        logFailureListingSummary();
        render();
        return;
      }

      state.activeIndex = nextIndex;
      const item = state.items[nextIndex];
      await processItem(item);
      render();
    }
  } finally {
    state.processing = false;
    render();
  }
}

async function processItem(item) {
  try {
    for (;;) {
      try {
        await runPlanStage(item);
        if (state.paused || state.stopRequested) return;
        await runExecuteStage(item);
        return;
      } catch (error) {
        if (!shouldRestartQueueItemAfterTimeout(item, error, state.stopRequested)) {
          throw error;
        }

        await stopCurrentGptGeneration();
        item.timeoutRestarted = true;
        resetItemForFullRetry(item);
        addLog("bad", `第 ${getQueueItemNumber(item)} 个超时未回复，已从规划开始整轮重试 1 次：${item.name}`);
        render();
      }
    }
  } catch (error) {
    if (state.stopRequested) {
      item.stage = STAGES.STOPPED;
      item.error = "";
      addLog("bad", `第 ${getQueueItemNumber(item)} 个已停止：${item.name}`);
      return;
    }

    markItemFailed(item, error, state.items);
    const sequenceNumber = getQueueItemNumber(item);
    if (item.failedPhase === "attach") {
      addLog("bad", `第 ${sequenceNumber} 个失败：phase=attach，${item.error || "附件未确认，已跳过发送 prompt。"} ${item.name}`);
    } else {
      addLog("bad", `第 ${sequenceNumber} 个失败：phase=${item.failedPhase || "unknown"}，${item.error}`);
    }
  }
}

async function runPlanStage(item) {
  for (;;) {
    if (state.stopRequested) throw new Error("已停止");
    try {
      item.attempts.plan += 1;
      const sequenceNumber = getQueueItemNumber(item);
      item.stage = STAGES.FETCHING_SOURCE;
      addLog("info", `第 ${sequenceNumber} 个 下载源图：${item.name}`);
      render();

      const file = await getItemFile(item);
      const dataUrl = await fileToDataUrl(file);
      const settings = await getLiveSettings();
      const operationId = makeOperationId(item, "plan");

      item.stage = STAGES.ATTACHING;
      addLog("info", `第 ${sequenceNumber} 个 准备上传并确认附件，operationId=${operationId}，确认成功后才发送规划。`);
      render();

      const response = await chatgptClient.plan({
        operationId,
        sequenceNumber,
        file: {
          name: file.name,
          type: file.type || guessMime(file.name),
          dataUrl
        },
        prompt: settings.planPrompt,
        timeoutMs: settings.taskTimeout * 1000
      });

      if (!response || !response.ok || !response.planText) {
        throw {
          phase: response?.phase || "plan",
          error: response?.error || "规划没有返回文本",
          diagnostics: response?.diagnostics || null
        };
      }

      item.stage = STAGES.PLANNED;
      item.planText = response.planText;
      item.diagnostics = response.diagnostics || item.diagnostics || null;
      addLog("ok", `第 ${sequenceNumber} 个 规划完成。`);
      render();
      return;
    } catch (error) {
      if (state.stopRequested) throw error;
      if (error?.phase === "attach") {
        throw error;
      }
      if (item.stage === STAGES.FETCHING_SOURCE && !error?.phase) {
        throw {
          phase: "fetching_source",
          error: error.message || String(error),
          diagnostics: makeItemDiagnostics(item)
        };
      }
      if (isQueueTimeoutError(error)) {
        throw error;
      }
      if (item.attempts.plan <= 1) {
        addLog("bad", `第 ${getQueueItemNumber(item)} 个 规划失败，准备重试：${error.message || error.error || error}`);
        continue;
      }
      throw {
        phase: error?.phase || "plan",
        error: `规划失败：${error.message || error.error || error}`,
        diagnostics: error?.diagnostics || makeItemDiagnostics(item)
      };
    }
  }
}

async function runExecuteStage(item) {
  let imageDataUrl = "";

  for (;;) {
    if (state.stopRequested) throw new Error("已停止");
    try {
      item.stage = STAGES.EXECUTING;
      item.attempts.execute += 1;
      const sequenceNumber = getQueueItemNumber(item);
      addLog("info", `第 ${sequenceNumber} 个 执行指令已发送，等待新图。`);
      render();

      const settings = await getLiveSettings();
      const operationId = makeOperationId(item, "execute");
      const response = await chatgptClient.execute({
        operationId,
        sequenceNumber,
        prompt: settings.executePrompt,
        timeoutMs: settings.taskTimeout * 1000
      });

      if (!response || !response.ok || !response.imageDataUrl) {
        throw {
          phase: response?.phase || "detecting_image",
          error: response?.error || "执行完成但没有检测到图片",
          diagnostics: response?.diagnostics || null
        };
      }

      imageDataUrl = response.imageDataUrl;
      item.stage = STAGES.DETECTING_IMAGE;
      item.diagnostics = response.diagnostics || item.diagnostics || null;
      addLog("info", `第 ${sequenceNumber} 个 已检测到生成图，开始下载。`);
      break;
    } catch (error) {
      if (state.stopRequested) throw error;
      if (isQueueTimeoutError(error)) {
        throw error;
      }
      if (item.attempts.execute <= 1) {
        addLog("bad", `第 ${getQueueItemNumber(item)} 个 执行失败，准备重试：${error.message || error.error || error}`);
        continue;
      }
      throw {
        phase: error?.phase || "execute",
        error: `执行失败：${error.message || error.error || error}`,
        diagnostics: error?.diagnostics || makeItemDiagnostics(item)
      };
    }
  }

  await downloadResult(item, imageDataUrl);
  item.stage = STAGES.COMPLETED;
  addLog("ok", `第 ${getQueueItemNumber(item)} 个 已完成并下载。`);
}

async function stopCurrentGptGeneration() {
  try {
    await chatgptClient.stop();
  } catch (error) {
    addLog("bad", `超时重试前停止 GPT 生成未收到确认：${error.message || error}`);
  }
}

async function downloadResult(item, imageDataUrl) {
  for (;;) {
    if (state.stopRequested) throw new Error("已停止");
    try {
      item.stage = STAGES.DOWNLOADING;
      item.attempts.download += 1;
      render();
      const filename = makeOutputFilename(item);
      await downloadImageData({
        imageDataUrl,
        filename
      });

      addLog("ok", `第 ${getQueueItemNumber(item)} 个 下载任务已创建：${filename}`);
      return;
    } catch (error) {
      if (state.stopRequested) throw error;
      if (item.attempts.download <= 1) {
        addLog("bad", `第 ${getQueueItemNumber(item)} 个 下载失败，准备重试：${error.message || error.error || error}`);
        continue;
      }
      throw {
        phase: error?.phase || "download",
        error: `下载失败：${error.message || error.error || error}`,
        diagnostics: error?.diagnostics || makeItemDiagnostics(item)
      };
    }
  }
}

async function setLockedGptTabId(tabId) {
  state.gptTabId = Number(tabId) || null;
  await chrome.storage.local.set({ [GPT_TAB_LOCK_KEY]: state.gptTabId });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

async function getItemFile(item) {
  if (item.file) return item.file;
  if (item.handle?.getFile) {
    const file = await item.handle.getFile();
    item.file = file;
    return file;
  }
  if (item.remoteUrl) {
    const file = await fetchRemoteImageAsFile(item);
    item.file = file;
    return file;
  }
  if (!item.handle || !item.handle.getFile) {
    throw new Error("图片文件句柄不可用，请重新选择文件夹。");
  }
}

async function fetchRemoteImageAsFile(item) {
  const response = await fetch(item.remoteUrl, {
    credentials: "omit",
    referrerPolicy: "no-referrer"
  });
  if (!response.ok) {
    throw new Error(`下载源图片失败：HTTP ${response.status}`);
  }

  const blob = await response.blob();
  if (!blob.size) {
    throw new Error("下载源图片失败：返回内容为空");
  }

  if (needsImageConversion(blob.type, item.remoteUrl)) {
    return await convertBlobToPngFile(blob, item.name);
  }

  const fileName = item.uploadName || buildFetchedImageName(item.name, blob.type, item.remoteUrl);
  const fileType = blob.type || guessMime(fileName);
  return new File([blob], fileName, { type: fileType });
}

function makeOutputFilename(item) {
  const name = item.name;
  const queueNumber = getQueueItemNumber(item);
  const prefix = shouldPrependSequence(name, queueNumber) ? `${formatSequenceNumber(queueNumber, state.items.length)}_` : "";
  const suffix = els.outputSuffix.value.trim() || "_temu_main";
  const dot = name.lastIndexOf(".");
  if (dot === -1) return `${prefix}${name}${suffix}.png`;
  return `${prefix}${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
}

function getQueueItemNumber(item) {
  return getQueueSequenceNumber(item, state.items);
}

function makeItemDiagnostics(item) {
  return {
    sequenceNumber: getQueueItemNumber(item),
    name: item.name || "",
    path: item.path || "",
    remoteUrl: item.remoteUrl || "",
    uploadName: item.uploadName || "",
    localCachePath: item.localCachePath || "",
    rowNumber: item.meta?.rowNumber || "",
    sourceColumn: item.meta?.sourceColumn || "",
    sourceNameHash: item.meta?.sourceNameHash || ""
  };
}

function getDisplayPath(file) {
  return file.webkitRelativePath || file.name;
}

function buildNumberedSourceFilename(sequenceNumber, total, fileName) {
  const cleanName = sanitizePathSegment(fileName || `image_${sequenceNumber}.png`);
  if (extractLeadingSequenceNumber(cleanName) === sequenceNumber) return cleanName;
  return `${formatSequenceNumber(sequenceNumber, total)}_${cleanName}`;
}

function shouldPrependSequence(name, sequenceNumber) {
  if (!sequenceNumber) return false;
  return extractLeadingSequenceNumber(name) !== sequenceNumber;
}

function formatSequenceNumber(sequenceNumber, total) {
  const width = Math.max(4, String(Math.max(Number(total) || 0, Number(sequenceNumber) || 0)).length);
  return String(sequenceNumber).padStart(width, "0");
}

function extractLeadingSequenceNumber(name) {
  const match = String(name || "").match(/^0*(\d{1,8})(?=[_\-\s])/);
  return match ? Number(match[1]) : 0;
}

function compareQueueLikeFiles(a, b) {
  const sequenceA = extractLeadingSequenceNumber(a.name || getDisplayPath(a));
  const sequenceB = extractLeadingSequenceNumber(b.name || getDisplayPath(b));
  if (sequenceA && sequenceB && sequenceA !== sequenceB) return sequenceA - sequenceB;
  if (sequenceA && !sequenceB) return -1;
  if (!sequenceA && sequenceB) return 1;
  return getDisplayPath(a).localeCompare(getDisplayPath(b), "zh-Hans-CN");
}

function compareQueueItemsBySequenceThenPath(a, b) {
  const sequenceA = Number(a.sequenceNumber) || extractLeadingSequenceNumber(a.name);
  const sequenceB = Number(b.sequenceNumber) || extractLeadingSequenceNumber(b.name);
  if (sequenceA && sequenceB && sequenceA !== sequenceB) return sequenceA - sequenceB;
  if (sequenceA && !sequenceB) return -1;
  if (!sequenceA && sequenceB) return 1;
  return String(a.path || a.name).localeCompare(String(b.path || b.name), "zh-Hans-CN");
}

function getExtension(name) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function guessMime(name) {
  const ext = getExtension(name);
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "avif") return "image/avif";
  return "image/png";
}

function buildFetchedImageName(baseName, mimeType, url) {
  const extension = extensionFromMime(mimeType) || getExtensionFromUrl(url) || "png";
  const normalizedBaseName = String(baseName || "template_image")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .trim() || "template_image";
  return `${normalizedBaseName}.${extension}`;
}

function buildCacheFolderName(templateName) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
  const base = sanitizePathSegment(String(templateName || "excel").replace(/\.[a-z0-9]+$/i, ""));
  return `temu-gpt-source-images-${stamp}-${base}`.slice(0, 120);
}

function sanitizePathSegment(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim() || "excel";
}

function extensionFromMime(mimeType) {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("jpeg")) return "jpg";
  if (normalized.includes("png")) return "png";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  if (normalized.includes("avif")) return "avif";
  return "";
}

function getExtensionFromUrl(url) {
  try {
    const parsed = new URL(url);
    return getExtension(parsed.pathname);
  } catch {
    return getExtension(String(url || "").split(/[?#]/, 1)[0]);
  }
}

function needsImageConversion(mimeType, url) {
  const extension = extensionFromMime(mimeType) || getExtensionFromUrl(url);
  return Boolean(extension && !["jpg", "jpeg", "png", "webp", "gif"].includes(extension));
}

async function convertBlobToPngFile(blob, baseName) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("图片转换失败：无法创建画布上下文");
  }

  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  const pngBlob = await new Promise((resolve, reject) => {
    canvas.toBlob((result) => {
      if (!result) {
        reject(new Error("图片转换失败：无法导出 PNG"));
        return;
      }
      resolve(result);
    }, "image/png");
  });

  return new File([pngBlob], buildFetchedImageName(baseName, "image/png", ""), { type: "image/png" });
}

function addLog(level, text) {
  state.log.unshift({
    level,
    text,
    time: new Date().toLocaleTimeString()
  });
}

function exportLog() {
  const failureListings = buildFailureListings();
  const rows = state.items.map((item) => ({
    sequenceNumber: getQueueItemNumber(item),
    failedSequenceNumber: item.failedSequenceNumber || "",
    listing: item.name,
    name: item.name,
    path: item.path,
    remoteUrl: item.remoteUrl || "",
    localCachePath: item.localCachePath || "",
    rowNumber: item.meta?.rowNumber || "",
    sourceColumn: item.meta?.sourceColumn || "",
    sourceName: item.meta?.sourceName || "",
    sourceNameHash: item.meta?.sourceNameHash || "",
    stage: item.stage,
    planAttempts: item.attempts.plan,
    executeAttempts: item.attempts.execute,
    downloadAttempts: item.attempts.download,
    failedPhase: item.failedPhase || "",
    error: item.error,
    diagnostics: item.diagnostics || null,
    planText: item.planText
  }));
  const payload = JSON.stringify({
    exportedAt: new Date().toISOString(),
    sourceDownloadFailedListings: failureListings.sourceDownloadFailedListings,
    executionFailedListings: failureListings.executionFailedListings,
    rows,
    log: state.log
  }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `temu-gpt-log-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function buildFailureListings() {
  const sourceDownloadFailedListings = [...state.sourceDownloadFailedListings];
  const executionFailedListings = [];

  for (const item of state.items) {
    if (item.stage !== STAGES.FAILED) continue;
    const entry = {
      sequenceNumber: getQueueItemNumber(item),
      listing: item.name,
      rowNumber: item.meta?.rowNumber || "",
      remoteUrl: item.remoteUrl || "",
      localCachePath: item.localCachePath || "",
      failedPhase: item.failedPhase || "",
      error: item.error || ""
    };

    if (item.failedPhase === "fetching_source") {
      if (!sourceDownloadFailedListings.some((failed) => Number(failed.sequenceNumber) === Number(entry.sequenceNumber))) {
        sourceDownloadFailedListings.push(entry);
      }
    } else if (["execute", "detecting_image", "download"].includes(item.failedPhase)) {
      executionFailedListings.push(entry);
    }
  }

  return { sourceDownloadFailedListings, executionFailedListings };
}

function logFailureListingSummary() {
  const { sourceDownloadFailedListings, executionFailedListings } = buildFailureListings();
  if (sourceDownloadFailedListings.length) {
    const preview = sourceDownloadFailedListings
      .slice(0, 5)
      .map((item) => `#${item.sequenceNumber} ${item.listing}`)
      .join("；");
    addLog("bad", `源图未下载 listing 共 ${sourceDownloadFailedListings.length} 个：${preview}`);
  }
  if (executionFailedListings.length) {
    const preview = executionFailedListings
      .slice(0, 5)
      .map((item) => `#${item.sequenceNumber} ${item.listing}`)
      .join("；");
    addLog("bad", `执行阶段未成功 listing 共 ${executionFailedListings.length} 个：${preview}`);
  }
}

function render() {
  const total = state.items.length;
  const success = state.items.filter((item) => item.stage === "completed").length;
  const failed = state.items.filter((item) => item.stage === "failed").length;
  const skipped = state.items.filter((item) => item.stage === "skipped").length;
  const stopped = state.items.filter((item) => item.stage === "stopped").length;
  const remaining = total - success - failed - skipped - stopped;
  const current = state.items[state.activeIndex];
  clampStartFromIndex();

  els.totalCount.textContent = total;
  els.successCount.textContent = success;
  els.failedCount.textContent = failed;
  els.remainingCount.textContent = remaining;
  els.importSummary.textContent = state.importSummary;
  els.currentFile.textContent = current ? current.name : "未开始";
  els.currentStage.textContent = current ? resolveStageLabel(current.stage) : (total ? "等待开始" : "等待选择文件夹");
  els.currentSequence.textContent = current
    ? `去重后序号：第 ${getQueueItemNumber(current)} / ${total} 个`
    : (total ? `去重后序号：共 ${total} 个` : "去重后序号：-");
  els.progressFill.style.width = total ? `${Math.round(((success + failed + skipped) / total) * 100)}%` : "0";
  els.planPreview.textContent = current && current.planText ? current.planText : "暂无规划。";

  els.startBtn.disabled = !total || state.running;
  els.startFromIndex.disabled = state.processing && !state.paused;
  els.pauseBtn.disabled = !state.running || state.paused;
  els.resumeBtn.disabled = !total || !state.paused;
  els.stopBtn.disabled = !state.running && !state.processing && !state.paused;
  els.clearBtn.disabled = !total || state.processing;
  els.exportLogBtn.disabled = !total && !state.log.length;

  els.log.innerHTML = "";
  for (const entry of state.log.slice(0, 120)) {
    const row = document.createElement("div");
    row.className = `log-entry ${entry.level === "ok" ? "ok" : entry.level === "bad" ? "bad" : ""}`;
    row.innerHTML = `<strong>${entry.time}</strong><span></span>`;
    row.querySelector("span").textContent = entry.text;
    els.log.appendChild(row);
  }

  if (state.canPublishDashboardState && !state.syncingDashboardState) {
    publishDashboardState().catch((error) => {
      console.warn("Failed to sync GPT dashboard state", error);
    });
  }
}

function enableDashboardPublishing() {
  state.canPublishDashboardState = true;
}

async function publishDashboardState() {
  await chrome.storage.local.set({ [DASHBOARD_STATE_KEY]: makeDashboardSnapshot() });
}

function makeDashboardSnapshot() {
  return {
    instanceId: state.instanceId,
    savedAt: Date.now(),
    items: state.items.map(serializeQueueItem),
    running: state.running,
    paused: state.paused,
    stopRequested: state.stopRequested,
    activeIndex: state.activeIndex,
    importSummary: state.importSummary,
    sourceDownloadFailedListings: state.sourceDownloadFailedListings,
    log: state.log.slice(0, 120)
  };
}

function serializeQueueItem(item) {
  return {
    id: item.id,
    name: item.name,
    path: item.path,
    remoteUrl: item.remoteUrl || "",
    uploadName: item.uploadName || "",
    localCachePath: item.localCachePath || "",
    sequenceNumber: getQueueItemNumber(item),
    meta: item.meta || null,
    stage: item.stage,
    attempts: item.attempts,
    timeoutRestarted: Boolean(item.timeoutRestarted),
    failedSequenceNumber: item.failedSequenceNumber || 0,
    failedPhase: item.failedPhase || "",
    diagnostics: item.diagnostics || null,
    planText: item.planText || "",
    error: item.error || ""
  };
}

function restoreDashboardSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.items)) return;
  state.items = snapshot.items.map((item, index) => ({
    id: item.id,
    file: null,
    handle: null,
    name: item.name,
    path: item.path,
    remoteUrl: item.remoteUrl || "",
    uploadName: item.uploadName || "",
    localCachePath: item.localCachePath || "",
    sequenceNumber: Number(item.sequenceNumber) || index + 1,
    meta: item.meta || null,
    stage: item.stage || "pending_plan",
    attempts: {
      plan: Number(item.attempts?.plan) || 0,
      execute: Number(item.attempts?.execute) || 0,
      download: Number(item.attempts?.download) || 0
    },
    timeoutRestarted: Boolean(item.timeoutRestarted),
    failedSequenceNumber: Number(item.failedSequenceNumber) || 0,
    failedPhase: item.failedPhase || "",
    diagnostics: item.diagnostics || null,
    planText: item.planText || "",
    error: item.error || ""
  }));
  state.running = Boolean(snapshot.running);
  state.processing = false;
  state.paused = Boolean(snapshot.paused);
  state.stopRequested = Boolean(snapshot.stopRequested);
  state.activeIndex = Number.isInteger(snapshot.activeIndex) ? snapshot.activeIndex : -1;
  state.importSummary = snapshot.importSummary || "等待导入。";
  state.sourceDownloadFailedListings = Array.isArray(snapshot.sourceDownloadFailedListings) ? snapshot.sourceDownloadFailedListings : [];
  state.log = Array.isArray(snapshot.log) ? snapshot.log.slice(0, 120) : [];
}

function makeInstanceId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeStartFromIndex() {
  const total = state.items.length;
  const max = Math.max(1, total || 1);
  const number = Math.floor(Number(els.startFromIndex.value) || 1);
  return Math.min(Math.max(number, 1), max);
}

function clampStartFromIndex() {
  const total = state.items.length;
  els.startFromIndex.max = String(Math.max(1, total || 1));
  const normalized = normalizeStartFromIndex();
  if (String(normalized) !== String(els.startFromIndex.value)) {
    els.startFromIndex.value = String(normalized);
  }
}

function applyStartFromIndex() {
  const startFromIndex = normalizeStartFromIndex();
  let skippedCount = 0;
  let resetCount = 0;
  for (let index = 0; index < state.items.length; index += 1) {
    const item = state.items[index];
    const sequenceNumber = getQueueItemNumber(item) || index + 1;

    if (isQueueActiveStage(item.stage)) {
      continue;
    }

    if (sequenceNumber < startFromIndex) {
      if (item.stage !== "skipped") {
        item.stage = "skipped";
        item.error = "";
        skippedCount += 1;
      }
      continue;
    }

    if (item.stage !== "pending_plan" || item.planText || item.error || item.attempts.plan || item.attempts.execute || item.attempts.download) {
      resetCount += 1;
    }
    item.stage = STAGES.PENDING_PLAN;
    item.error = "";
    item.failedPhase = "";
    item.failedSequenceNumber = 0;
    item.diagnostics = null;
    item.planText = "";
    item.attempts = { plan: 0, execute: 0, download: 0 };
  }

  addLog("info", `已按去重后绝对序号从第 ${startFromIndex} 个开始：前 ${skippedCount} 个标记跳过，后 ${resetCount} 个重置为待规划。`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
