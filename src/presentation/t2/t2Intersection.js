import {
  extractUniquePriceSkcText,
  importT2Products
} from "../../application/usecases/importT2Products.js";
import { readRowsFromBrowserFile } from "../../infrastructure/xlsx/browserXlsxSheetIO.js";
import { saveT2IntersectionResult } from "../../infrastructure/storage/t2ResultStore.js";

const state = {
  products: [],
  summary: null,
  duplicatePriceSkcs: [],
  duplicatePriceSkcRows: [],
  priceHeaderRow: [],
  priceSkcText: "",
  priceSkcStatus: "尚未提取",
  log: []
};

const els = {
  infoFile: document.getElementById("infoFile"),
  priceFile: document.getElementById("priceFile"),
  processButton: document.getElementById("processButton"),
  priceSkcText: document.getElementById("priceSkcText"),
  copyPriceSkcButton: document.getElementById("copyPriceSkcButton"),
  priceSkcStatus: document.getElementById("priceSkcStatus"),
  infoRowCount: document.getElementById("infoRowCount"),
  infoUniqueSkcCount: document.getElementById("infoUniqueSkcCount"),
  priceUniqueSkcCount: document.getElementById("priceUniqueSkcCount"),
  matchedProductCount: document.getElementById("matchedProductCount"),
  resultSummary: document.getElementById("resultSummary"),
  resultRows: document.getElementById("resultRows"),
  duplicateSummary: document.getElementById("duplicateSummary"),
  duplicateRows: document.getElementById("duplicateRows"),
  log: document.getElementById("log")
};

bindEvents();
render();
addLog("T2 交集处理已就绪。");

function bindEvents() {
  els.priceFile.addEventListener("change", extractPriceSkcTextFromPriceFile);
  els.processButton.addEventListener("click", processIntersection);
  els.copyPriceSkcButton.addEventListener("click", copyPriceSkcText);
}

async function processIntersection() {
  const infoFile = els.infoFile.files?.[0];
  const priceFile = els.priceFile.files?.[0];
  if (!infoFile || !priceFile) {
    addLog("请先选择信息表和价格表。");
    return;
  }

  setBusy(true);
  try {
    const infoRows = await readRowsFromBrowserFile(infoFile);
    const priceRows = await readRowsFromBrowserFile(priceFile);
    const result = importT2Products({ infoRows, priceRows });
    state.products = result.products;
    state.summary = result.summary;
    state.duplicatePriceSkcs = result.duplicatePriceSkcs;
    state.duplicatePriceSkcRows = result.duplicatePriceSkcRows;
    state.priceHeaderRow = result.priceHeaderRow;
    await saveT2IntersectionResult({
      products: state.products,
      summary: state.summary
    });
    await openResultPreview();
    addLog(`处理完成：交集商品 ${result.summary.matchedProductCount} 个，重复 SKC ${result.summary.duplicatePriceSkcCount ?? 0} 个。`);
  } catch (error) {
    addLog(`处理失败：${error.message || error}`);
  } finally {
    setBusy(false);
    render();
  }
}

async function extractPriceSkcTextFromPriceFile() {
  const priceFile = els.priceFile.files?.[0];
  if (!priceFile) {
    state.priceSkcStatus = "尚未提取";
    state.priceSkcText = "";
    render();
    return;
  }

  state.priceSkcStatus = "正在读取价格表...";
  state.priceSkcText = "";
  render();
  try {
    const priceRows = await readRowsFromBrowserFile(priceFile);
    const text = extractUniquePriceSkcText(priceRows);
    const count = text ? text.split(",").length : 0;
    state.priceSkcText = text;
    state.priceSkcStatus = count ? `已提取 ${count} 个去重 SKC。` : "没有从 A2 开始读取到 SKC。";
    addLog(state.priceSkcStatus);
  } catch (error) {
    state.priceSkcText = "";
    state.priceSkcStatus = `提取失败：${error.message || error}`;
    addLog(state.priceSkcStatus);
  } finally {
    render();
  }
}

async function copyPriceSkcText() {
  if (!state.priceSkcText) {
    addLog("没有可复制的 SKC 文本。");
    return;
  }

  try {
    await navigator.clipboard.writeText(state.priceSkcText);
    addLog("SKC 文本已复制到剪贴板。");
  } catch (error) {
    addLog(`复制失败：${error.message || error}`);
  }
}

async function openResultPreview() {
  await chrome.tabs.create({
    url: chrome.runtime.getURL("src/presentation/t2/resultPreview.html")
  });
  addLog("已打开固定 HTML 预览页。");
}

function render() {
  const summary = state.summary ?? {
    infoRowCount: 0,
    infoUniqueSkcCount: 0,
    priceUniqueSkcCount: 0,
    matchedProductCount: 0,
    duplicatePriceSkcCount: 0,
    duplicatePriceRowCount: 0
  };
  els.infoRowCount.textContent = summary.infoRowCount;
  els.infoUniqueSkcCount.textContent = summary.infoUniqueSkcCount;
  els.priceUniqueSkcCount.textContent = summary.priceUniqueSkcCount;
  els.matchedProductCount.textContent = summary.matchedProductCount;
  els.resultSummary.textContent = state.products.length ? `${state.products.length} 条结果` : "暂无结果";
  els.duplicateSummary.textContent = state.duplicatePriceSkcs.length
    ? `${summary.duplicatePriceSkcCount ?? 0} 个 SKC，${summary.duplicatePriceRowCount ?? 0} 行`
    : "暂无重复";
  els.priceSkcText.value = state.priceSkcText;
  els.priceSkcStatus.textContent = state.priceSkcStatus;
  els.copyPriceSkcButton.disabled = !state.priceSkcText;

  els.resultRows.innerHTML = "";
  for (const product of state.products) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${escapeHtml(product.name ?? "")}</td>
      <td>${escapeHtml(product.imageUrl ?? "")}</td>
      <td>${escapeHtml(product.skc ?? "")}</td>
      <td>${escapeHtml(product.quotedPrice ?? "")}</td>
    `;
    els.resultRows.appendChild(row);
  }

  els.duplicateRows.innerHTML = "";
  for (const duplicateRow of state.duplicatePriceSkcs) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${escapeHtml(duplicateRow.skc ?? "")}</td>
      <td>${escapeHtml(duplicateRow.occurrenceCount ?? "")}</td>
      <td>${escapeHtml((duplicateRow.rowNumbers ?? []).join(", "))}</td>
      <td>${escapeHtml((duplicateRow.rawQuotedPrices ?? []).join(", "))}</td>
      <td>${escapeHtml(duplicateRow.selectedQuotedPrice ?? "")}</td>
      <td>${escapeHtml((duplicateRow.selectedRowNumbers ?? []).join(", "))}</td>
    `;
    els.duplicateRows.appendChild(row);
  }

  els.log.innerHTML = "";
  for (const entry of state.log.slice(0, 80)) {
    const row = document.createElement("div");
    row.className = "log-entry";
    row.innerHTML = `<strong>${escapeHtml(entry.time)}</strong><span>${escapeHtml(entry.text)}</span>`;
    els.log.appendChild(row);
  }
}

function setBusy(isBusy) {
  els.processButton.disabled = isBusy;
  els.processButton.textContent = isBusy ? "处理中..." : "处理交集";
}

function addLog(text) {
  state.log.unshift({
    time: new Date().toLocaleTimeString(),
    text: String(text)
  });
  render();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
