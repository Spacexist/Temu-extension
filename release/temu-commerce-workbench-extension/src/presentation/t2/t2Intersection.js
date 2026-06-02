import { importT2Products } from "../../application/usecases/importT2Products.js";
import { readRowsFromBrowserFile } from "../../infrastructure/xlsx/browserXlsxSheetIO.js";
import { saveT2IntersectionResult } from "../../infrastructure/storage/t2ResultStore.js";

const state = {
  products: [],
  summary: null,
  duplicatePriceSkcs: [],
  duplicatePriceSkcRows: [],
  priceHeaderRow: [],
  log: []
};

const els = {
  infoFile: document.getElementById("infoFile"),
  priceFile: document.getElementById("priceFile"),
  processButton: document.getElementById("processButton"),
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
  els.processButton.addEventListener("click", processIntersection);
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
