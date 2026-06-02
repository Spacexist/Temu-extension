import { buildWorkbookBuffer } from "./excel_writer.js";
import {
  mergeJsonRecordsBySkc,
  productsToT2JsonRecords
} from "../../application/usecases/appendT2ProductsToJson.js";
import { calculateProfit, loadConfig, money, parseNumber, percent } from "./calc.js";
import {
  listenForProductCollectionChanges,
  loadProductCollection,
  removeProductIdsFromCollection
} from "../../infrastructure/storage/productCollectionStore.js";
import { readJsonRecordsFromFileHandle, writeJsonRecordsToFileHandle } from "./json_file_store.js";
import { formatQuantityBoundValue, parseQuantityBoundNumber } from "./quantity_binding.js";
import {
  loadJsonFileHandle,
  loadJsonFileMeta,
  saveJsonFileHandle,
  saveJsonFileMeta
} from "./storage.js";

const JSON_FILE_NAME = "records.json";
const WORKBOOK_FILE_NAME = "records.xlsx";
const AUTO_CALC_FIELDS = ["quotedPrice", "unitPrice", "weight", "discountRate"];
const QUANTITY_BOUND_FIELDS = {
  quotedPrice: { decimals: 2 },
  unitPrice: { decimals: 2 },
  weight: { decimals: 3 }
};
const EXTERNAL_IMPORT_COOLDOWN_MS = 15000;
const AUTO_FETCH_RETRY_DELAYS_MS = [0, 400, 1200, 2500];

const state = {
  config: null,
  currentImage: null,
  records: [],
  jsonFileHandle: null,
  jsonFileMeta: null,
  quantityBaseValues: {
    quotedPrice: null,
    unitPrice: null,
    weight: null
  },
  collectionProducts: [],
  selectedCollectionIds: new Set(),
  lastProductSignature: "",
  lastTabId: null,
  isSaving: false,
  isPageFetchInFlight: false,
  lastAutoFetchKey: "",
  lastExternalImportAt: 0,
  lastImportedFlag: "",
  lastImportedPayloadSignature: "",
  autoFetchRetryToken: 0
};

const elements = {
  bindJsonButton: document.querySelector("#bindJsonButton"),
  createJsonButton: document.querySelector("#createJsonButton"),
  cacheSummaryText: document.querySelector("#cacheSummaryText"),
  collectionSummary: document.querySelector("#collectionSummary"),
  collectionList: document.querySelector("#collectionList"),
  refreshCollectionButton: document.querySelector("#refreshCollectionButton"),
  loadSelectedCollectionButton: document.querySelector("#loadSelectedCollectionButton"),
  appendSelectedJsonButton: document.querySelector("#appendSelectedJsonButton"),
  removeSelectedCollectionButton: document.querySelector("#removeSelectedCollectionButton"),
  statusText: document.querySelector("#statusText"),
  name: document.querySelector("#name"),
  skc: document.querySelector("#skc"),
  quotedPrice: document.querySelector("#quotedPrice"),
  unitPrice: document.querySelector("#unitPrice"),
  weight: document.querySelector("#weight"),
  quantity: document.querySelector("#quantity"),
  discountRate: document.querySelector("#discountRate"),
  url: document.querySelector("#url"),
  imagePreview: document.querySelector("#imagePreview"),
  imagePlaceholder: document.querySelector("#imagePlaceholder"),
  imageDropzone: document.querySelector("#imageDropzone"),
  refreshPageButton: document.querySelector("#refreshPageButton"),
  calculateButton: document.querySelector("#calculateButton"),
  pasteImageButton: document.querySelector("#pasteImageButton"),
  clearImageButton: document.querySelector("#clearImageButton"),
  saveButton: document.querySelector("#saveButton"),
  exportButton: document.querySelector("#exportButton"),
  clearButton: document.querySelector("#clearButton"),
  actualPriceResult: document.querySelector("#actualPriceResult"),
  firstLegFeeResult: document.querySelector("#firstLegFeeResult"),
  firstLegCostResult: document.querySelector("#firstLegCostResult"),
  lastLegCostResult: document.querySelector("#lastLegCostResult"),
  profitResult: document.querySelector("#profitResult"),
  cargoLossResult: document.querySelector("#cargoLossResult"),
  actualProfitResult: document.querySelector("#actualProfitResult"),
  roiResult: document.querySelector("#roiResult"),
  marginResult: document.querySelector("#marginResult")
};

function setStatus(message) {
  elements.statusText.textContent = message;
}

function renderStorageSummary() {
  if (!elements.cacheSummaryText) return;
  elements.cacheSummaryText.textContent = `当前 JSON：${state.records.length} 条`;
}

function renderCollection() {
  if (!elements.collectionList || !elements.collectionSummary) {
    return;
  }

  const validIds = new Set(state.collectionProducts.map(collectionProductId));
  state.selectedCollectionIds = new Set(
    Array.from(state.selectedCollectionIds).filter((id) => validIds.has(id))
  );

  elements.collectionSummary.textContent = state.collectionProducts.length
    ? `已采集 ${state.collectionProducts.length} 个商品，已选 ${state.selectedCollectionIds.size} 个。`
    : "暂无采集商品。";

  elements.collectionList.innerHTML = "";
  if (!state.collectionProducts.length) {
    const empty = document.createElement("div");
    empty.className = "record-empty";
    empty.textContent = "请先在 T2 商品结果预览页点击“加入采集列表”。";
    elements.collectionList.appendChild(empty);
  }

  for (const product of state.collectionProducts) {
    const productId = collectionProductId(product);
    const item = document.createElement("label");
    item.className = "record-item collection-item";
    item.innerHTML = `
      <input type="checkbox" name="collectionProduct" value="${escapeHtml(productId)}" ${state.selectedCollectionIds.has(productId) ? "checked" : ""}>
      <div class="collection-body">
        <div class="record-name">${escapeHtml(product.name || "-")}</div>
        <div class="record-meta">SKC: ${escapeHtml(product.skc || "-")} · 核价: ${escapeHtml(product.quotedPrice ?? "-")}</div>
      </div>
    `;
    elements.collectionList.appendChild(item);
  }

  elements.loadSelectedCollectionButton.disabled = false;
  elements.appendSelectedJsonButton.disabled = false;
  elements.removeSelectedCollectionButton.disabled = false;
}

function resetResults() {
  [
    elements.actualPriceResult,
    elements.firstLegFeeResult,
    elements.firstLegCostResult,
    elements.lastLegCostResult,
    elements.profitResult,
    elements.cargoLossResult,
    elements.actualProfitResult,
    elements.roiResult,
    elements.marginResult
  ].forEach((element) => {
    element.textContent = "-";
  });
}

function getPositiveQuantityForBinding() {
  const quantity = parseQuantityBoundNumber(elements.quantity.value || "1");
  return quantity && quantity > 0 ? quantity : null;
}

function setQuantityBaseValue(fieldId, value) {
  if (!(fieldId in QUANTITY_BOUND_FIELDS)) {
    return;
  }

  const number = parseQuantityBoundNumber(value);
  state.quantityBaseValues[fieldId] = number;
}

function clearQuantityBaseValue(fieldId) {
  if (fieldId in QUANTITY_BOUND_FIELDS) {
    state.quantityBaseValues[fieldId] = null;
  }
}

function clearQuantityBaseValues() {
  Object.keys(QUANTITY_BOUND_FIELDS).forEach(clearQuantityBaseValue);
}

function syncQuantityBaseValueFromField(fieldId) {
  if (!(fieldId in QUANTITY_BOUND_FIELDS) || state.quantityBaseValues[fieldId] === null) {
    return;
  }

  const displayedValue = parseQuantityBoundNumber(elements[fieldId].value);
  if (displayedValue === null) {
    clearQuantityBaseValue(fieldId);
    return;
  }

  const quantity = getPositiveQuantityForBinding() || 1;
  state.quantityBaseValues[fieldId] = displayedValue / quantity;
}

function applyQuantityBindingToFields() {
  const quantity = getPositiveQuantityForBinding();
  if (!quantity) {
    return;
  }

  for (const [fieldId, config] of Object.entries(QUANTITY_BOUND_FIELDS)) {
    const baseValue = state.quantityBaseValues[fieldId];
    if (baseValue === null) {
      continue;
    }

    elements[fieldId].value = formatQuantityBoundValue(baseValue, quantity, config.decimals);
  }
}

function getQuantityAwareNumber(fieldId, fieldName) {
  const baseValue = state.quantityBaseValues[fieldId];
  if (baseValue !== null && baseValue !== undefined) {
    return baseValue;
  }

  return parseNumber(elements[fieldId].value, fieldName);
}

function getFormValues() {
  return {
    name: elements.name.value.trim(),
    skc: elements.skc.value.trim(),
    quotedPrice: getQuantityAwareNumber("quotedPrice", "核价"),
    unitPrice: getQuantityAwareNumber("unitPrice", "单件"),
    weight: getQuantityAwareNumber("weight", "重量"),
    quantity: parseNumber(elements.quantity.value || "1", "倍数"),
    discountRatePercent: parseNumber(elements.discountRate.value, "折扣率"),
    url: elements.url.value.trim()
  };
}

function calculateAndRender({ quiet = false } = {}) {
  if (!state.config) {
    return null;
  }

  try {
    const values = getFormValues();
    const result = calculateProfit({
      quotedPrice: values.quotedPrice,
      unitPrice: values.unitPrice,
      weight: values.weight,
      quantity: values.quantity,
      discountRate: values.discountRatePercent / 100,
      config: state.config
    });

    elements.actualPriceResult.textContent = money(result.actualPrice);
    elements.firstLegFeeResult.textContent = money(result.firstLegFee);
    elements.firstLegCostResult.textContent = money(result.firstLegCost);
    elements.lastLegCostResult.textContent = money(result.lastLegCost);
    elements.profitResult.textContent = money(result.profit);
    elements.cargoLossResult.textContent = money(result.cargoLoss);
    elements.actualProfitResult.textContent = money(result.actualProfit);
    elements.roiResult.textContent = percent(result.roi);
    elements.marginResult.textContent = percent(result.margin);

    if (!quiet) {
      setStatus("已完成计算。");
    }

    return { values, result };
  } catch (error) {
    resetResults();
    if (!quiet) {
      setStatus(error.message);
    }
    return null;
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

function buildTabFetchKey(tabId, url) {
  return `${tabId || ""}|${url || ""}`;
}

async function sendExtractMessage(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "extract-product-data" });
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/legacy/1688/content.js"]
    });
    return chrome.tabs.sendMessage(tabId, { type: "extract-product-data" });
  }
}

function buildProductSignature(data) {
  return [
    data?.name || "",
    data?.skc || "",
    data?.quotedPrice || data?.quoted_price || "",
    data?.unitPrice || "",
    data?.weight || "",
    data?.goodsPrice || "",
    data?.shippingFee || "",
    data?.sent_at || ""
  ].join("|");
}

function isExternalImportCoolingDown() {
  return Date.now() - state.lastExternalImportAt < EXTERNAL_IMPORT_COOLDOWN_MS;
}

function hasUsefulProductData(data) {
  return Boolean(data && (data.unitPrice || data.weight || data.url || data.goodsPrice || data.shippingFee));
}

function isProductDataComplete(data) {
  return Boolean(data && data.unitPrice && data.weight);
}

function getImageExtension(blob) {
  const mime = blob.type || "image/png";
  if (mime.includes("jpeg") || mime.includes("jpg")) {
    return "jpg";
  }
  if (mime.includes("webp")) {
    return "webp";
  }
  return "png";
}

async function setCurrentImage(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const objectUrl = URL.createObjectURL(blob);

  if (state.currentImage?.objectUrl) {
    URL.revokeObjectURL(state.currentImage.objectUrl);
  }

  state.currentImage = {
    blob,
    bytes,
    extension: getImageExtension(blob),
    mimeType: blob.type || "image/png",
    objectUrl
  };

  elements.imagePreview.src = objectUrl;
  elements.imagePreview.hidden = false;
  elements.imagePlaceholder.hidden = true;
}

function clearImage() {
  if (state.currentImage?.objectUrl) {
    URL.revokeObjectURL(state.currentImage.objectUrl);
  }

  state.currentImage = null;
  elements.imagePreview.removeAttribute("src");
  elements.imagePreview.hidden = true;
  elements.imagePlaceholder.hidden = false;
}

async function loadImageFromUrl(imageUrl) {
  await setCurrentImage(await fetchImageBlob(imageUrl));
}

async function fetchImageBlob(imageUrl) {
  const response = await fetch(imageUrl, {
    credentials: "omit",
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`图片下载失败，状态码 ${response.status}`);
  }

  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) {
    throw new Error("图片地址返回的不是有效图片。");
  }

  return blob;
}

async function pasteImageFromClipboard() {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith("image/"));
      if (imageType) {
        await setCurrentImage(await item.getType(imageType));
        setStatus("图片已粘贴。");
        return;
      }
    }

    setStatus("剪贴板里没有图片。");
  } catch (error) {
    setStatus(`粘贴失败，请先聚焦图片区后再尝试 Ctrl+V。${error.message ? ` ${error.message}` : ""}`);
  }
}

async function handlePaste(event) {
  const item = Array.from(event.clipboardData?.items || []).find((entry) => entry.type.startsWith("image/"));
  if (!item) {
    return;
  }

  const blob = item.getAsFile();
  if (blob) {
    await setCurrentImage(blob);
    setStatus("图片已粘贴。");
  }
}

async function applyImportedProductCard(entry, { force = false } = {}) {
  const flag = String(entry?.flag || "").trim();
  const payload = entry?.payload;
  if (!payload) {
    return false;
  }

  const signature = buildProductSignature(payload);
  if (!force && flag && flag === state.lastImportedFlag && signature === state.lastImportedPayloadSignature) {
    return false;
  }

  state.lastImportedFlag = flag;
  state.lastImportedPayloadSignature = signature;
  state.lastExternalImportAt = Date.now();

  elements.name.value = payload.name || "";
  elements.skc.value = payload.skc || "";
  elements.quotedPrice.value = payload.quoted_price || "";
  setQuantityBaseValue("quotedPrice", payload.quoted_price || "");
  elements.url.value = "";

  if (!elements.quantity.value) {
    elements.quantity.value = "1";
  }
  applyQuantityBindingToFields();

  let imageLoaded = false;
  let imageErrorMessage = "";
  if (payload.image_url) {
    try {
      await loadImageFromUrl(payload.image_url);
      imageLoaded = true;
    } catch (error) {
      imageErrorMessage = error?.message || "图片加载失败，请手动补图。";
    }
  }

  calculateAndRender({ quiet: true });
  if (imageLoaded) {
    setStatus(`已从预览页导入商品：${payload.name || payload.skc}，图片已自动载入。`);
  } else if (imageErrorMessage) {
    setStatus(`已从预览页导入商品：${payload.name || payload.skc}，但${imageErrorMessage}`);
  } else {
    setStatus(`已从预览页导入商品：${payload.name || payload.skc}。`);
  }

  return true;
}

function applyProductData(data, { force = false, source = "1688-page" } = {}) {
  if (!hasUsefulProductData(data)) {
    return false;
  }

  const signature = buildProductSignature(data);
  if (!force && signature === state.lastProductSignature) {
    return false;
  }

  state.lastProductSignature = signature;
  if (data.unitPrice) {
    setQuantityBaseValue("unitPrice", data.unitPrice);
    elements.unitPrice.value = data.unitPrice;
  }
  if (data.weight) {
    setQuantityBaseValue("weight", data.weight);
    elements.weight.value = data.weight;
  }
  if (data.url) {
    elements.url.value = data.url;
  }
  if (!elements.quantity.value) {
    elements.quantity.value = "1";
  }
  applyQuantityBindingToFields();

  calculateAndRender({ quiet: true });
  const shippingText = data.shippingFee ? `，含运费 ${data.shippingFee}` : "";
  const weightText = data.weight ? `，重量 ${data.weight}` : "";
  setStatus(`已抓取当前 1688 页面：单价+运费 ${data.unitPrice || "-"}${shippingText}${weightText}。`);
  return true;
}

async function fillFromPage({ force = false, tab = null } = {}) {
  const activeTab = tab ?? (await getActiveTab());
  state.lastTabId = activeTab?.id ?? null;

  if (!activeTab?.id || !/^https:\/\/(?:detail\.)?1688\.com\//i.test(activeTab.url || "")) {
    if (!isExternalImportCoolingDown()) {
      setStatus("请打开 1688 商品详情页，侧边栏会自动抓取单件和重量。");
    }
    return;
  }

  const fetchKey = buildTabFetchKey(activeTab.id, activeTab.url || "");
  if (!force && (state.isPageFetchInFlight || fetchKey === state.lastAutoFetchKey)) {
    return { applied: false, complete: false, data: null, skipped: true };
  }

  state.isPageFetchInFlight = true;
  try {
    const data = await sendExtractMessage(activeTab.id);
    const applied = applyProductData(data, { force, source: "1688-page" });
    const complete = isProductDataComplete(data);

    if (complete) {
      state.lastAutoFetchKey = fetchKey;
    }

    if (!complete && hasUsefulProductData(data) && !isExternalImportCoolingDown()) {
      if (data.unitPrice && !data.weight) {
        setStatus("已抓到价格，正在继续等待 1688 页面重量数据。");
      } else {
        setStatus("1688 页面已打开，但价格/运费/重量还没渲染完成，正在重试。");
      }
    }

    return { applied, complete, data, skipped: false };
  } catch (error) {
    setStatus(`抓取失败：${error.message}`);
    return { applied: false, complete: false, data: null, skipped: false };
  } finally {
    state.isPageFetchInFlight = false;
  }
}

async function fillFromPageWithRetry({ tab = null, reason = "auto" } = {}) {
  const retryToken = Date.now();
  state.autoFetchRetryToken = retryToken;

  for (let index = 0; index < AUTO_FETCH_RETRY_DELAYS_MS.length; index += 1) {
    const delay = AUTO_FETCH_RETRY_DELAYS_MS[index];
    if (delay > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, delay));
    }

    if (state.autoFetchRetryToken !== retryToken) {
      return false;
    }

    const result = await fillFromPage({
      force: true,
      tab
    });

    if (result?.complete) {
      return true;
    }
  }

  const currentWeight = elements.weight?.value?.trim() || "";
  const currentUnitPrice = elements.unitPrice?.value?.trim() || "";
  if (!isExternalImportCoolingDown()) {
    if (currentUnitPrice && !currentWeight) {
      setStatus("价格已经抓到，但重量还没有抓到。你可以停留当前商品页 1 到 2 秒后再试一次。");
    } else {
      setStatus(`已尝试自动抓取 1688 页面，但还没有拿到有效的价格/运费/重量。${reason === "manual" ? "" : "你也可以点一次“刷新页面数据”。"}`);
    }
  }
  return false;
}

async function hydrateImportedProductCard() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "get-latest-imported-product-card"
    });
    if (response?.ok && response.entry) {
      await applyImportedProductCard(response.entry, { force: true });
    }
  } catch (_error) {
    // Best effort only.
  }
}

async function hydrateProductCollection() {
  state.collectionProducts = await loadProductCollection();
  renderCollection();
}

async function refreshProductCollectionManually() {
  await hydrateProductCollection();
  setStatus(`采集列表已刷新：${state.collectionProducts.length} 个商品。`);
}

function getSelectedCollectionProducts() {
  const selectedIds = state.selectedCollectionIds;
  return state.collectionProducts.filter((product) => selectedIds.has(collectionProductId(product)));
}

function collectionProductId(product) {
  return String(product?.id || product?.skc || "").trim();
}

function productToImportedEntry(product) {
  return {
    flag: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    payload: {
      type: "product-card-transfer",
      name: String(product.name || ""),
      skc: String(product.skc || ""),
      quoted_price: String(product.quotedPrice ?? ""),
      image_url: String(product.imageUrl || ""),
      source: "t2-collection",
      sent_at: new Date().toISOString()
    }
  };
}

async function loadSelectedCollectionProductToForm() {
  const [product] = getSelectedCollectionProducts();
  if (!product) {
    setStatus("请先在采集列表里选择一个商品。");
    return;
  }

  await applyImportedProductCard(productToImportedEntry(product), { force: true });
  setStatus(`已加入前端表单：${product.name || product.skc}`);
}

async function appendSelectedCollectionToJson() {
  const products = getSelectedCollectionProducts();
  if (!products.length) {
    setStatus("请先在采集列表里选择商品。");
    return;
  }

  try {
    const records = await loadRecordsFromJson({ interactive: true });
    const incomingRecords = productsToT2JsonRecords(products);
    const result = mergeJsonRecordsBySkc(records, incomingRecords);
    await writeJsonRecordsToFileHandle(state.jsonFileHandle, result.records);
    state.records = result.records;
    renderStorageSummary();
    setStatus(`已续写 JSON：新增 ${result.addedCount} 条，更新 ${result.updatedCount} 条，当前共 ${result.records.length} 条。`);
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

async function removeSelectedCollectionProducts() {
  const ids = Array.from(state.selectedCollectionIds);
  if (!ids.length) {
    setStatus("请先在采集列表里选择商品。");
    return;
  }

  state.collectionProducts = await removeProductIdsFromCollection(ids);
  state.selectedCollectionIds.clear();
  renderCollection();
  setStatus(`已从采集列表移除 ${ids.length} 个商品。`);
}

function ensureReadyToSave() {
  if (!state.currentImage) {
    throw new Error("请先准备图片，再保存记录。");
  }

  const calculated = calculateAndRender({ quiet: true });
  if (!calculated) {
    throw new Error("请先补全参数，确保当前商品可以计算。");
  }

  return calculated;
}

function getJsonFilePickerTypes() {
  return [
    {
      description: "JSON 文件",
      accept: {
        "application/json": [".json"]
      }
    }
  ];
}

function getJsonOpenPickerOptions() {
  return {
    multiple: false,
    types: getJsonFilePickerTypes()
  };
}

function getJsonSavePickerOptions() {
  return {
    suggestedName: JSON_FILE_NAME,
    types: getJsonFilePickerTypes()
  };
}

async function verifyFilePermission(handle, write = false) {
  if (!handle) {
    return false;
  }

  const options = write ? { mode: "readwrite" } : {};
  if ((await handle.queryPermission(options)) === "granted") {
    return true;
  }

  if ((await handle.requestPermission(options)) === "granted") {
    return true;
  }

  return false;
}

async function hasFilePermission(handle, write = false) {
  if (!handle) {
    return false;
  }

  const options = write ? { mode: "readwrite" } : {};
  return (await handle.queryPermission(options)) === "granted";
}

async function bindJsonFileHandle(handle, { initializeEmptyFile = false } = {}) {
  const granted = await verifyFilePermission(handle, true);
  if (!granted) {
    throw new Error("未授予 JSON 文件读写权限。");
  }

  const records = await readJsonRecordsFromFileHandle(handle);
  if (initializeEmptyFile && records.length === 0) {
    await writeJsonRecordsToFileHandle(handle, records);
  }

  state.jsonFileHandle = handle;
  state.jsonFileMeta = {
    name: handle.name,
    boundAt: new Date().toISOString()
  };
  state.records = records;

  await saveJsonFileHandle(handle);
  await saveJsonFileMeta(state.jsonFileMeta);
  renderStorageSummary();
  return handle;
}

async function bindExistingJsonFile() {
  if (!window.showOpenFilePicker) {
    throw new Error("当前浏览器环境不支持选择已有 JSON 文件。");
  }

  const [handle] = await window.showOpenFilePicker(getJsonOpenPickerOptions());
  return bindJsonFileHandle(handle);
}

async function createJsonFile() {
  if (!window.showSaveFilePicker) {
    throw new Error("当前浏览器环境不支持新建本地 JSON 文件。");
  }

  const handle = await window.showSaveFilePicker(getJsonSavePickerOptions());
  return bindJsonFileHandle(handle, { initializeEmptyFile: true });
}

async function chooseJsonFile() {
  if (window.showOpenFilePicker) {
    try {
      return await bindExistingJsonFile();
    } catch (error) {
      if (error?.name !== "AbortError") {
        throw error;
      }
    }
  }

  return createJsonFile();
}

async function ensureJsonFileReady({ interactive = false, write = false } = {}) {
  if (!state.jsonFileHandle) {
    if (!interactive) {
      throw new Error("请先绑定本地 JSON 文件。");
    }
    await chooseJsonFile();
  }

  const granted = await verifyFilePermission(state.jsonFileHandle, write);
  if (!granted) {
    if (interactive) {
      throw new Error("没有拿到本地 JSON 文件权限，请重新绑定文件。");
    }
    throw new Error("本地 JSON 文件当前不可访问。");
  }

  return state.jsonFileHandle;
}

async function loadRecordsFromJson({ interactive = false } = {}) {
  const handle = await ensureJsonFileReady({ interactive, write: false });
  const records = await readJsonRecordsFromFileHandle(handle);
  state.records = records;
  renderStorageSummary();
  return records;
}

async function hydrateJsonFileState() {
  state.jsonFileHandle = await loadJsonFileHandle();
  state.jsonFileMeta = await loadJsonFileMeta();

  if (!state.jsonFileHandle) {
    renderStorageSummary();
    return;
  }

  try {
    if (await hasFilePermission(state.jsonFileHandle, false)) {
      state.records = await readJsonRecordsFromFileHandle(state.jsonFileHandle);
    }
  } catch (_error) {
    state.records = [];
  }

  renderStorageSummary();
}

function downloadArrayBuffer(fileName, arrayBuffer, mimeType) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([arrayBuffer], { type: mimeType });
    const url = URL.createObjectURL(blob);

    chrome.downloads.download(
      {
        url,
        filename: fileName,
        saveAs: true,
        conflictAction: "overwrite"
      },
      (downloadId) => {
        window.setTimeout(() => URL.revokeObjectURL(url), 30000);
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(downloadId);
      }
    );
  });
}

function buildCurrentRecord() {
  const { values, result } = ensureReadyToSave();
  const imageFile = `${Date.now()}_${values.skc || "image"}.${state.currentImage.extension}`;

  return {
    ...values,
    imageFile,
    imageBytes: Array.from(state.currentImage.bytes),
    imageExtension: state.currentImage.extension,
    imageMimeType: state.currentImage.mimeType,
    result,
    savedAt: new Date().toISOString()
  };
}

async function saveCurrentRecord() {
  if (state.isSaving) {
    return;
  }

  state.isSaving = true;
  elements.saveButton.disabled = true;

  try {
    const record = buildCurrentRecord();
    const records = await loadRecordsFromJson({ interactive: true });
    const nextRecords = [...records, record];
    await writeJsonRecordsToFileHandle(state.jsonFileHandle, nextRecords);
    state.records = nextRecords;
    renderStorageSummary();
    clearImage();
    setStatus(`已写入本地 JSON。当前共 ${state.records.length} 条记录。`);
  } catch (error) {
    setStatus(error.message);
  } finally {
    state.isSaving = false;
    elements.saveButton.disabled = false;
  }
}

async function exportWorkbook() {
  if (state.isSaving) {
    return;
  }

  state.isSaving = true;
  elements.exportButton.disabled = true;

  try {
    const records = await loadRecordsFromJson({ interactive: true });
    if (records.length === 0) {
      throw new Error("JSON 里还没有记录，请先保存至少一条商品。");
    }

    const workbookBuffer = await buildWorkbookBuffer(records, resolveSavedRecordImage);

    await downloadArrayBuffer(
      WORKBOOK_FILE_NAME,
      workbookBuffer,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    setStatus(`已根据 ${records.length} 条 JSON 记录导出 Excel。`);
  } catch (error) {
    setStatus(error.message);
  } finally {
    state.isSaving = false;
    elements.exportButton.disabled = false;
  }
}

async function resolveSavedRecordImage(savedRecord) {
  if (Array.isArray(savedRecord.imageBytes) && savedRecord.imageBytes.length) {
    return {
      bytes: new Uint8Array(savedRecord.imageBytes),
      extension: savedRecord.imageExtension || "png",
      mimeType: savedRecord.imageMimeType || "image/png"
    };
  }

  const imageUrl = String(savedRecord.imageUrl || savedRecord.image_url || "").trim();
  if (!imageUrl) {
    throw new Error(`${savedRecord.name || savedRecord.skc || "记录"} 缺少图片，无法导出 Excel。`);
  }

  const blob = await fetchImageBlob(imageUrl);
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    extension: getImageExtension(blob),
    mimeType: blob.type || "image/png"
  };
}

function clearForm() {
  elements.name.value = "";
  elements.skc.value = "";
  elements.quotedPrice.value = "";
  elements.unitPrice.value = "";
  elements.weight.value = "";
  elements.quantity.value = "1";
  elements.discountRate.value = state.config ? money(Number(state.config.discount_rate) * 100) : "100.00";
  elements.url.value = "";
  state.lastProductSignature = "";
  state.lastAutoFetchKey = "";
  state.lastExternalImportAt = 0;
  state.lastImportedFlag = "";
  state.lastImportedPayloadSignature = "";
  clearQuantityBaseValues();
  clearImage();
  resetResults();
  setStatus("表单已清空。");
}

async function bindJsonFileManually() {
  try {
    await bindExistingJsonFile();
    setStatus(`已绑定已有 JSON：${state.jsonFileHandle.name}，当前读取到 ${state.records.length} 条。`);
  } catch (error) {
    if (error?.name === "AbortError") {
      setStatus("已取消绑定 JSON 文件。");
      return;
    }
    setStatus(error.message);
  }
}

async function createJsonFileManually() {
  try {
    await createJsonFile();
    setStatus(`已新建本地 JSON：${state.jsonFileHandle.name}。`);
  } catch (error) {
    if (error?.name === "AbortError") {
      setStatus("已取消新建 JSON 文件。");
      return;
    }
    setStatus(error.message);
  }
}

function handleActiveTabChangedMessage(message) {
  if (message?.type !== "active-tab-changed") {
    return false;
  }

  fillFromPageWithRetry({
    reason: "tab-changed",
    tab: message.tabId
      ? {
          id: message.tabId,
          url: message.url || ""
        }
      : null
  });
  return true;
}

function bindEvents() {
  elements.bindJsonButton.addEventListener("click", bindJsonFileManually);
  elements.createJsonButton.addEventListener("click", createJsonFileManually);
  elements.refreshCollectionButton?.addEventListener("click", refreshProductCollectionManually);
  elements.loadSelectedCollectionButton?.addEventListener("click", loadSelectedCollectionProductToForm);
  elements.appendSelectedJsonButton?.addEventListener("click", appendSelectedCollectionToJson);
  elements.removeSelectedCollectionButton?.addEventListener("click", removeSelectedCollectionProducts);
  elements.collectionList?.addEventListener("change", (event) => {
    if (event.target?.name !== "collectionProduct") return;
    const id = String(event.target.value || "");
    if (event.target.checked) {
      state.selectedCollectionIds.add(id);
    } else {
      state.selectedCollectionIds.delete(id);
    }
    renderCollection();
  });
  elements.refreshPageButton.addEventListener("click", () => fillFromPageWithRetry({ reason: "manual" }));
  elements.calculateButton.addEventListener("click", () => calculateAndRender());
  elements.pasteImageButton.addEventListener("click", pasteImageFromClipboard);
  elements.clearImageButton.addEventListener("click", clearImage);
  elements.saveButton.addEventListener("click", saveCurrentRecord);
  elements.exportButton.addEventListener("click", exportWorkbook);
  elements.clearButton.addEventListener("click", clearForm);
  elements.imageDropzone.addEventListener("paste", handlePaste);
  document.addEventListener("paste", handlePaste);

  AUTO_CALC_FIELDS.forEach((id) => {
    const handleFieldChange = () => {
      if (id === "quantity") {
        applyQuantityBindingToFields();
      } else {
        syncQuantityBaseValueFromField(id);
      }
      calculateAndRender({ quiet: true });
    };

    elements[id].addEventListener("input", handleFieldChange);
    elements[id].addEventListener("change", handleFieldChange);
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (handleActiveTabChangedMessage(message)) {
      return;
    }

    if (message?.type === "product-collection-refresh") {
      hydrateProductCollection();
      return;
    }

    if (message?.type === "import-product-card" && message.entry) {
      applyImportedProductCard(message.entry, { force: true });
    }
  });

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) {
      return;
    }

    if (event.data?.type === "product-collection-refresh") {
      hydrateProductCollection();
      return;
    }

    handleActiveTabChangedMessage(event.data);
  });

  window.addEventListener("focus", () => {
    hydrateProductCollection();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      hydrateProductCollection();
    }
  });

  listenForProductCollectionChanges(() => {
    hydrateProductCollection();
  });
}

async function init() {
  bindEvents();
  state.config = await loadConfig();
  elements.discountRate.value = money(Number(state.config.discount_rate) * 100);
  elements.quantity.value = elements.quantity.value || "1";
  renderStorageSummary();
  await hydrateJsonFileState();
  await hydrateProductCollection();
  await hydrateImportedProductCard();
  await fillFromPageWithRetry({ reason: "init" });
}

init().catch((error) => {
  setStatus(error.message);
});

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
