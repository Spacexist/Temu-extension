import { readRowsFromBrowserFile } from "../../infrastructure/xlsx/browserXlsxSheetIO.js";
import { importTemplateMainImages } from "../../application/usecases/importTemplateMainImages.js";

const CHATGPT_URL = "https://chatgpt.com/";
const CHATGPT_PATTERN = /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\//i;
const CONTENT_SCRIPT = "src/legacy/gptDebug/contentScript.js";
const MAX_EXCEL_IMAGES = 500;

const els = {
  gptStatus: document.getElementById("gptStatus"),
  queueStatus: document.getElementById("queueStatus"),
  sequenceStatus: document.getElementById("sequenceStatus"),
  phaseStatus: document.getElementById("phaseStatus"),
  openGptBtn: document.getElementById("openGptBtn"),
  stateBtn: document.getElementById("stateBtn"),
  stopBtn: document.getElementById("stopBtn"),
  templateInput: document.getElementById("templateInput"),
  templateBtn: document.getElementById("templateBtn"),
  folderInput: document.getElementById("folderInput"),
  folderBtn: document.getElementById("folderBtn"),
  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  indexInput: document.getElementById("indexInput"),
  currentImage: document.getElementById("currentImage"),
  directPrompt: document.getElementById("directPrompt"),
  importStatus: document.getElementById("importStatus"),
  attachBtn: document.getElementById("attachBtn"),
  sendPromptBtn: document.getElementById("sendPromptBtn"),
  detectImageBtn: document.getElementById("detectImageBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  runOneBtn: document.getElementById("runOneBtn"),
  resultPreview: document.getElementById("resultPreview"),
  diagnosticsOutput: document.getElementById("diagnosticsOutput"),
  clearLogBtn: document.getElementById("clearLogBtn"),
  logList: document.getElementById("logList")
};

const state = {
  gptTabId: null,
  files: [],
  index: 0,
  currentDataUrl: "",
  lastImageDataUrl: "",
  lastDiagnostics: null,
  excelFailures: [],
  busy: false
};

window.addEventListener("error", (event) => {
  reportFatal("panel-error", event.error || event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  reportFatal("panel-rejection", event.reason);
});

bindEvents();
render();
log("info", "调试器已就绪：选择图片文件夹后，可以单步测试附件和发送。每一步都会写日志和 diagnostics。");

function bindEvents() {
  els.openGptBtn.addEventListener("click", () => runStep("open-gpt", openGpt));
  els.stateBtn.addEventListener("click", () => runStep("dom-state", readDomState));
  els.stopBtn.addEventListener("click", () => runStep("stop", stopGpt));
  els.templateBtn.addEventListener("click", () => els.templateInput.click());
  els.templateInput.addEventListener("change", (event) => runStep("excel-cache", () => importExcelTemplate(event)));
  els.folderBtn.addEventListener("click", () => runStep("choose-folder", chooseFolder));
  els.folderInput.addEventListener("change", onFolderSelected);
  els.prevBtn.addEventListener("click", () => moveIndex(-1));
  els.nextBtn.addEventListener("click", () => moveIndex(1));
  els.indexInput.addEventListener("change", () => setIndex(Number(els.indexInput.value) - 1));
  els.attachBtn.addEventListener("click", () => runStep("attach", attachCurrentImage));
  els.sendPromptBtn.addEventListener("click", () => runStep("send-prompt", sendPrompt));
  els.detectImageBtn.addEventListener("click", () => runStep("detect-image", detectImage));
  els.downloadBtn.addEventListener("click", () => runStep("download", downloadLastImage));
  els.runOneBtn.addEventListener("click", () => runStep("run-one", runCurrentFullFlow));
  els.clearLogBtn.addEventListener("click", () => { els.logList.innerHTML = ""; });
}

async function onFolderSelected() {
  const files = Array.from(els.folderInput.files || [])
    .filter((file) => file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|avif)$/i.test(file.name))
    .map((file) => ({
      name: file.name,
      path: file.webkitRelativePath || file.name,
      file
    }))
    .sort(compareFiles);
  state.files = files;
  state.index = 0;
  state.currentDataUrl = "";
  state.lastImageDataUrl = "";
  els.resultPreview.textContent = "暂无生成图";
  log("ok", `已载入 ${files.length} 个图片引用。fallback 模式会由浏览器提供 FileList，后续仍只读取当前图片。`);
  render();
  await loadCurrentImagePreview();
}

async function importExcelTemplate(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    if (!window.showDirectoryPicker) {
      throw new Error("当前浏览器不支持选择缓存目录，无法下载 Excel URL 图片。");
    }

    state.excelFailures = [];
    state.currentDataUrl = "";
    state.lastImageDataUrl = "";
    els.resultPreview.textContent = "暂无生成图";
    log("info", `读取模板 Excel：${file.name}`);

    const rows = await readRowsFromBrowserFile(file);
    const result = importTemplateMainImages(rows, {
      idPrefix: `debug-template-${Date.now()}`
    });
    const items = result.items.slice(0, MAX_EXCEL_IMAGES);
    if (!items.length) {
      throw new Error("模板中没有识别到可用的轮播图/产品素材图链接。");
    }

    els.importStatus.textContent = `Excel：扫描 ${result.summary.rowsScanned} 行，去重后 ${items.length} 张，A 列重复跳过 ${result.summary.duplicateNameRowCount} 行。请选择图片缓存目录。`;
    log("info", "请选择 Excel URL 图片缓存目录，插件会在里面新建子文件夹。");

    const rootHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    const cacheFolderName = buildCacheFolderName(file.name);
    const cacheHandle = await rootHandle.getDirectoryHandle(cacheFolderName, { create: true });
    const cachedItems = [];

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const sequenceNumber = index + 1;
      try {
        log("info", `第 ${sequenceNumber} 个 下载 Excel 图片：${item.name}`);
        const downloadedFile = await fetchRemoteImageAsFile({
          name: item.name,
          remoteUrl: item.imageUrl,
          uploadName: item.uploadName
        });
        const numberedName = buildNumberedSourceFilename(sequenceNumber, items.length, downloadedFile.name);
        const cachedFile = new File([downloadedFile], numberedName, { type: downloadedFile.type || guessMime(numberedName) });
        const fileHandle = await cacheHandle.getFileHandle(numberedName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(cachedFile);
        await writable.close();

        cachedItems.push({
          name: numberedName,
          path: `${cacheFolderName}/${numberedName}`,
          handle: fileHandle,
          sequenceNumber,
          meta: {
            rowNumber: item.rowNumber,
            title: item.title,
            sourceColumn: item.sourceColumn,
            remoteUrl: item.imageUrl
          }
        });
        log("ok", `第 ${sequenceNumber} 个 已缓存：${cacheFolderName}/${numberedName}`);
      } catch (error) {
        const failed = {
          sequenceNumber,
          listing: item.name,
          rowNumber: item.rowNumber || "",
          remoteUrl: item.imageUrl || "",
          error: String(error?.message || error)
        };
        state.excelFailures.push(failed);
        log("bad", `第 ${sequenceNumber} 个源图下载失败：${failed.error}`);
      }
    }

    state.files = cachedItems;
    state.index = 0;
    els.importStatus.textContent = `Excel 缓存完成：成功 ${cachedItems.length} 张，失败 ${state.excelFailures.length} 张，目录 ${cacheFolderName}。成功项已自动载入调试队列。`;
    setDiagnostics({
      ok: true,
      phase: "excel-cache",
      summary: {
        rowsScanned: result.summary.rowsScanned,
        cachedCount: cachedItems.length,
        failedCount: state.excelFailures.length,
        cacheFolderName
      },
      failedListings: state.excelFailures
    });
    render();
    await loadCurrentImagePreview();
  } finally {
    els.templateInput.value = "";
  }
}

async function chooseFolder() {
  if (!window.showDirectoryPicker) {
    log("bad", "当前环境不支持 showDirectoryPicker，降级为浏览器文件夹选择。");
    els.folderInput.click();
    return;
  }

  const directoryHandle = await window.showDirectoryPicker({ mode: "read" });
  log("info", `开始扫描文件名：${directoryHandle.name}`);
  const files = await collectImageHandles(directoryHandle);
  state.files = files.sort(compareFiles);
  state.index = 0;
  state.currentDataUrl = "";
  state.lastImageDataUrl = "";
  els.resultPreview.textContent = "暂无生成图";
  log("ok", `已索引 ${state.files.length} 张图片。只保存句柄，不读取图片内容。`);
  render();
  await loadCurrentImagePreview();
}

async function collectImageHandles(directoryHandle, parentPath = "") {
  const items = [];
  for await (const [name, handle] of directoryHandle.entries()) {
    const path = parentPath ? `${parentPath}/${name}` : name;
    if (handle.kind === "directory") {
      items.push(...await collectImageHandles(handle, path));
      continue;
    }
    if (handle.kind === "file" && isImageName(name)) {
      items.push({ name, path, handle });
    }
  }
  return items;
}

function isImageName(name) {
  return /\.(png|jpe?g|webp|gif|avif)$/i.test(String(name || ""));
}

function compareFiles(a, b) {
  const na = leadingNumber(a.name || a.path);
  const nb = leadingNumber(b.name || b.path);
  if (na && nb && na !== nb) return na - nb;
  if (na && !nb) return -1;
  if (!na && nb) return 1;
  return String(a.path || a.name).localeCompare(String(b.path || b.name), "zh-Hans-CN");
}

function leadingNumber(name) {
  const match = String(name || "").match(/^0*(\d{1,8})(?=[_\-\s])/);
  return match ? Number(match[1]) : 0;
}

function moveIndex(delta) {
  setIndex(state.index + delta);
}

function setIndex(nextIndex) {
  if (!state.files.length) return;
  state.index = Math.max(0, Math.min(state.files.length - 1, Number(nextIndex) || 0));
  state.currentDataUrl = "";
  state.lastImageDataUrl = "";
  render();
  loadCurrentImagePreview();
}

async function loadCurrentImagePreview() {
  const item = currentFile();
  if (!item) return;
  const file = await getItemFile(item);
  const dataUrl = await fileToDataUrl(file);
  state.currentDataUrl = dataUrl;
  els.currentImage.innerHTML = `<strong>${escapeHtml(currentSequenceText())}</strong><br>${escapeHtml(item.path || file.name)}<img src="${dataUrl}" alt="current">`;
  render();
}

async function openGpt() {
  const tab = await prepareGptTab({ active: true });
  state.gptTabId = tab.id;
  log("ok", `GPT 标签已绑定：tabId=${tab.id}`);
  return await readDomState();
}

async function readDomState() {
  const response = await sendToGpt({ type: "debug:getState" }, 8000);
  setDiagnostics(response);
  log(response.ok ? "ok" : "bad", `DOM 状态读取${response.ok ? "成功" : "失败"}。`);
  return response;
}

async function stopGpt() {
  const response = await sendToGpt({ type: "debug:stop" }, 5000);
  setDiagnostics(response);
  log(response.ok ? "ok" : "bad", response.ok ? "已请求停止 GPT 当前生成。" : `停止失败：${response.error || "未知错误"}`);
  return response;
}

async function attachCurrentImage() {
  const file = await ensureCurrentFileReady();
  const operationId = makeOperationId("attach");
  state.lastImageDataUrl = "";
  els.resultPreview.textContent = "暂无生成图";
  log("info", `${currentSequenceText()} 开始注入附件：${file.name}`);
  const response = await sendToGpt({
    type: "debug:attach",
    operationId,
    sequenceNumber: currentSequenceNumber(),
    file: { name: file.name, type: file.type || guessMime(file.name), dataUrl: state.currentDataUrl },
    timeoutMs: 45000
  }, 65000);
  setDiagnostics(response);
  if (!response.ok) throw new Error(response.error || "附件注入失败");
  log("ok", `${currentSequenceText()} 附件确认成功。`);
  return response;
}

async function sendPrompt() {
  const prompt = els.directPrompt.value.trim();
  if (!prompt) throw new Error("提示词为空");
  const operationId = makeOperationId("prompt");
  state.lastImageDataUrl = "";
  els.resultPreview.textContent = "暂无生成图";
  log("info", `${currentSequenceText()} 发送提示词，operationId=${operationId}`);
  const response = await sendToGpt({
    type: "debug:sendPrompt",
    operationId,
    sequenceNumber: currentSequenceNumber(),
    prompt,
    timeoutMs: 30000
  }, 45000);
  setDiagnostics(response);
  if (!response.ok) throw new Error(response.error || "发送提示词失败");
  log("ok", `${currentSequenceText()} 提示词已发送。`);
  return response;
}

async function detectImage() {
  const operationId = makeOperationId("detect");
  log("info", `${currentSequenceText()} 开始检测生成图。`);
  const response = await sendToGpt({
    type: "debug:detectImage",
    operationId,
    sequenceNumber: currentSequenceNumber(),
    timeoutMs: 420000
  }, 440000);
  setDiagnostics(response);
  if (!response.ok || !response.imageDataUrl) throw new Error(response.error || "没有检测到生成图");
  state.lastImageDataUrl = response.imageDataUrl;
  els.resultPreview.innerHTML = `<strong>${escapeHtml(currentSequenceText())} 已检测到生成图</strong><img src="${response.imageDataUrl}" alt="generated">`;
  log("ok", `${currentSequenceText()} 已检测到生成图：${response.width || 0}x${response.height || 0}`);
  render();
  return response;
}

async function downloadLastImage() {
  if (!state.lastImageDataUrl) throw new Error("暂无可下载的生成图，请先检测生成图。");
  const file = currentFile();
  const filename = makeOutputFilename(file);
  const response = await chrome.runtime.sendMessage({
    type: "debug:downloadImageData",
    imageDataUrl: state.lastImageDataUrl,
    filename
  });
  setDiagnostics(response);
  if (!response.ok) throw new Error(response.error || "下载失败");
  log("ok", `${currentSequenceText()} 下载任务已创建：${response.result.filename}`);
  return response;
}

async function runCurrentFullFlow() {
  await attachCurrentImage();
  await sendPrompt();
  await detectImage();
  await downloadLastImage();
  log("ok", `${currentSequenceText()} 完整流程完成。`);
}

async function prepareGptTab({ active = false } = {}) {
  let tab = await findGptTab();
  if (!tab) tab = await chrome.tabs.create({ url: CHATGPT_URL, active });
  if (active) await chrome.tabs.update(tab.id, { active: true });
  state.gptTabId = tab.id;
  await waitForTabComplete(tab.id);
  await ensureContentScript(tab.id);
  return await chrome.tabs.get(tab.id);
}

async function findGptTab() {
  if (state.gptTabId) {
    try {
      const tab = await chrome.tabs.get(state.gptTabId);
      if (CHATGPT_PATTERN.test(tab.url || "")) return tab;
    } catch (_error) { state.gptTabId = null; }
  }
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const active = activeTabs.find((tab) => CHATGPT_PATTERN.test(tab.url || ""));
  if (active) return active;
  const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
  return tabs[0] || null;
}

async function sendToGpt(message, timeoutMs) {
  const tab = await prepareGptTab({ active: false });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`GPT 页面响应超时：${message.type}`)), timeoutMs || 30000);
    chrome.tabs.sendMessage(tab.id, message, (response) => {
      clearTimeout(timer);
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response || { ok: false, error: "GPT 页面没有响应" });
    });
  });
}

async function ensureContentScript(tabId) {
  let injectError = "";
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
  } catch (error) {
    injectError = error?.message || String(error);
  }
  for (let i = 0; i < 20; i += 1) {
    try {
      const response = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, { type: "ping" }, (res) => {
          const error = chrome.runtime.lastError;
          if (error) reject(error);
          else resolve(res);
        });
      });
      if (response?.ok) return;
    } catch (_error) {}
    await delay(350);
  }
  throw new Error(`GPT content script 未就绪${injectError ? `：${injectError}` : ""}`);
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, 15000);
    function done() { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(); }
    function listener(updatedTabId, info) { if (updatedTabId === tabId && info.status === "complete") done(); }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => { if (chrome.runtime.lastError || tab?.status === "complete") done(); });
  });
}

async function ensureCurrentFileReady() {
  const item = currentFile();
  if (!item) throw new Error("请先选择图片文件夹。 ");
  const file = await getItemFile(item);
  if (!state.currentDataUrl) state.currentDataUrl = await fileToDataUrl(file);
  return file;
}

async function getItemFile(item) {
  if (item.file) return item.file;
  if (item.handle?.getFile) {
    item.file = await item.handle.getFile();
    return item.file;
  }
  throw new Error("当前图片文件句柄不可用，请重新选择图片文件夹。");
}

function currentFile() { return state.files[state.index] || null; }
function currentSequenceNumber() { return Number(currentFile()?.sequenceNumber) || leadingNumber(currentFile()?.name) || state.index + 1; }
function currentSequenceText() { return `第 ${currentSequenceNumber()} 个`; }
function makeOperationId(stage) { return `${stage}-${Date.now()}-${currentSequenceNumber()}`; }
function guessMime(name) { return /\.webp$/i.test(name) ? "image/webp" : /\.jpe?g$/i.test(name) ? "image/jpeg" : /\.gif$/i.test(name) ? "image/gif" : "image/png"; }
function makeOutputFilename(file) {
  const name = file?.name || `image_${currentSequenceNumber()}.png`;
  const dot = name.lastIndexOf(".");
  const stem = dot === -1 ? name : name.slice(0, dot);
  return `${String(currentSequenceNumber()).padStart(4, "0")}_${stem}_temu_main.png`;
}
function fileToDataUrl(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error("读取图片失败")); reader.onload = () => resolve(reader.result); reader.readAsDataURL(file); }); }
function setDiagnostics(value) { state.lastDiagnostics = value; els.diagnosticsOutput.textContent = JSON.stringify(value, null, 2); }
async function runStep(phase, fn) {
  if (state.busy) return;
  state.busy = true; els.phaseStatus.textContent = phase; renderButtons();
  const started = performance.now();
  try { const result = await fn(); log("ok", `${phase} 完成，耗时 ${Math.round(performance.now() - started)}ms`); return result; }
  catch (error) {
    if (phase === "detect-image" || phase === "run-one") {
      state.lastImageDataUrl = "";
      els.resultPreview.textContent = "没有检测到可下载的新生成图";
    }
    log("bad", `${phase} 失败：${error.message || error}`);
    setDiagnostics({ ok: false, phase, error: String(error.message || error), lastDiagnostics: state.lastDiagnostics });
  }
  finally { state.busy = false; renderButtons(); render(); }
}
function render() {
  els.gptStatus.textContent = state.gptTabId ? `tab ${state.gptTabId}` : "未绑定";
  els.queueStatus.textContent = String(state.files.length);
  els.sequenceStatus.textContent = state.files.length ? `${state.index + 1}/${state.files.length} (${currentSequenceNumber()})` : "-";
  els.indexInput.value = String(state.index + 1);
  if (!state.files.length) els.currentImage.textContent = "未选择图片";
  renderButtons();
}
function renderButtons() { document.querySelectorAll("button").forEach((button) => { button.disabled = state.busy && button.id !== "stopBtn"; }); }
function log(kind, text) {
  const item = document.createElement("div"); item.className = `log-item ${kind}`;
  item.innerHTML = `<span class="log-time">${new Date().toLocaleTimeString("zh-CN", { hour12: false })}</span><span class="log-text">${escapeHtml(text)}</span>`;
  els.logList.prepend(item);
}
function reportFatal(phase, error) {
  const payload = {
    ok: false,
    phase,
    error: String(error?.message || error || "未知错误"),
    stack: error?.stack || ""
  };
  try {
    els.diagnosticsOutput.textContent = JSON.stringify(payload, null, 2);
    log("bad", `${phase}：${payload.error}`);
  } catch (_error) {
    console.error(payload);
  }
}
function escapeHtml(value) { return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchRemoteImageAsFile(item) {
  const response = await fetch(item.remoteUrl, {
    credentials: "omit",
    referrerPolicy: "no-referrer"
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const blob = await response.blob();
  if (!blob.size) {
    throw new Error("返回内容为空");
  }
  if (needsImageConversion(blob.type, item.remoteUrl)) {
    return await convertBlobToPngFile(blob, item.name);
  }
  const fileName = item.uploadName || buildFetchedImageName(item.name, blob.type, item.remoteUrl);
  return new File([blob], fileName, { type: blob.type || guessMime(fileName) });
}

function buildNumberedSourceFilename(sequenceNumber, total, fileName) {
  const cleanName = sanitizePathSegment(fileName || `image_${sequenceNumber}.png`);
  if (leadingNumber(cleanName) === sequenceNumber) return cleanName;
  return `${formatSequenceNumber(sequenceNumber, total)}_${cleanName}`;
}

function formatSequenceNumber(sequenceNumber, total) {
  const width = Math.max(4, String(Math.max(Number(total) || 0, Number(sequenceNumber) || 0)).length);
  return String(sequenceNumber).padStart(width, "0");
}

function buildFetchedImageName(baseName, mimeType, url) {
  const extension = extensionFromMime(mimeType) || getExtensionFromUrl(url) || "png";
  const normalizedBaseName = sanitizePathSegment(String(baseName || "template_image").replace(/\.[a-z0-9]{2,5}$/i, ""));
  return `${normalizedBaseName}.${extension}`;
}

function buildCacheFolderName(templateName) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const base = sanitizePathSegment(String(templateName || "excel").replace(/\.[a-z0-9]+$/i, ""));
  return `temu-gpt-source-images-${stamp}-${base}`.slice(0, 120);
}

function sanitizePathSegment(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim() || "excel";
}

function getExtension(name) {
  const dot = String(name || "").lastIndexOf(".");
  return dot === -1 ? "" : String(name).slice(dot + 1).toLowerCase();
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
    return getExtension(new URL(url).pathname);
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
  if (!context) throw new Error("无法创建画布上下文");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const pngBlob = await new Promise((resolve, reject) => {
    canvas.toBlob((result) => result ? resolve(result) : reject(new Error("无法导出 PNG")), "image/png");
  });
  return new File([pngBlob], buildFetchedImageName(baseName, "image/png", ""), { type: "image/png" });
}
