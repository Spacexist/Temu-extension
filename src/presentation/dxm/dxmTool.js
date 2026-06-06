const els = {
  collectBtn: document.getElementById("collectBtn"),
  copyBtn: document.getElementById("copyBtn"),
  selectCountBtn: document.getElementById("selectCountBtn"),
  selectCountInput: document.getElementById("selectCountInput"),
  statusText: document.getElementById("statusText"),
  resultPreview: document.getElementById("resultPreview"),
  plainTextOutput: document.getElementById("plainTextOutput"),
  logOutput: document.getElementById("logOutput")
};

let latestOutput = "";

els.collectBtn.addEventListener("click", collectCategoryCorrections);
els.copyBtn.addEventListener("click", copyLatestOutput);
els.selectCountBtn.addEventListener("click", selectDxmRows);

function setStatus(text) {
  els.statusText.textContent = text;
}

function setBusy(isBusy) {
  els.collectBtn.disabled = isBusy;
  els.selectCountBtn.disabled = isBusy;
  els.collectBtn.textContent = isBusy ? "采集中..." : "采集分类建议";
  els.selectCountBtn.textContent = isBusy ? "处理中..." : "按数量选择";
}

function renderLogs(logs) {
  const lines = Array.isArray(logs) && logs.length ? logs : ["暂无日志"];
  els.logOutput.textContent = lines.join("\n");
}

function cleanText(text) {
  return String(text || "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function createTextElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function renderEmptyResult(text = "采集结果会显示在这里") {
  els.resultPreview.replaceChildren();
  els.resultPreview.appendChild(createTextElement("div", "empty-state", text));
}

function buildPlainText(items) {
  if (!items.length) {
    return "商品分类修正建议\n\n全部 SKC：\n\n未采集到带有“商品分类错误待修正”的商品。";
  }

  const skcList = items.map((item) => cleanText(item.skc)).filter(Boolean).join(",");
  const blocks = items.map((item, index) => {
    const suggestions = [item.suggestion1, item.suggestion2, item.suggestion3]
      .map((text, suggestionIndex) => `${suggestionIndex + 1}. ${cleanText(text) || "-"}`)
      .join("\n");

    return [
      `${index + 1}. ${cleanText(item.listing) || "未识别商品标题"}`,
      `SKC：${cleanText(item.skc) || "-"}`,
      `原先错误类目：${cleanText(item.originalCategory) || "-"}`,
      "修改建议：",
      suggestions
    ].join("\n");
  });

  return ["商品分类修正建议", "", `全部 SKC：${skcList}`, "", ...blocks].join("\n\n");
}

function renderResultPreview(items) {
  els.resultPreview.replaceChildren();

  if (!items.length) {
    renderEmptyResult("未采集到可展示的商品。");
    return;
  }

  const skcList = items.map((item) => cleanText(item.skc)).filter(Boolean);
  const summary = document.createElement("section");
  summary.className = "result-summary";
  summary.appendChild(createTextElement("div", "summary-label", `共 ${items.length} 条`));
  summary.appendChild(createTextElement("div", "summary-skcs", skcList.join(",") || "暂无 SKC"));
  els.resultPreview.appendChild(summary);

  items.forEach((item, index) => {
    const card = document.createElement("article");
    card.className = "result-card";
    card.appendChild(createTextElement("h2", "", `${index + 1}. ${cleanText(item.listing) || "未识别商品标题"}`));
    card.appendChild(createTextElement("span", "skc-badge", `SKC ${cleanText(item.skc) || "-"}`));

    const category = document.createElement("div");
    category.appendChild(createTextElement("div", "block-label", "原先错误类目"));
    category.appendChild(createTextElement("div", "category-text", cleanText(item.originalCategory) || "-"));
    card.appendChild(category);

    const suggestions = document.createElement("div");
    suggestions.appendChild(createTextElement("div", "block-label", "修改建议"));
    const list = document.createElement("ol");
    list.className = "suggestions-list";
    [item.suggestion1, item.suggestion2, item.suggestion3].forEach((suggestion) => {
      list.appendChild(createTextElement("li", "", cleanText(suggestion) || "-"));
    });
    suggestions.appendChild(list);
    card.appendChild(suggestions);

    els.resultPreview.appendChild(card);
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("未找到当前标签页");
  }
  return tab;
}

async function runInActiveTab(func, args = []) {
  const tab = await getActiveTab();
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func,
    args
  });
  return results?.[0]?.result;
}

async function collectCategoryCorrections() {
  setBusy(true);
  latestOutput = "";
  els.plainTextOutput.value = "";
  els.copyBtn.disabled = true;
  renderEmptyResult("正在采集，请稍候...");
  renderLogs(["开始采集分类建议..."]);
  setStatus("正在读取当前页面...");

  try {
    const response = await runInActiveTab(collectCategoryCorrectionsInPage);
    const items = Array.isArray(response?.items) ? response.items : [];
    latestOutput = buildPlainText(items);
    els.plainTextOutput.value = latestOutput;
    renderResultPreview(items);
    renderLogs(response?.logs);
    els.copyBtn.disabled = !latestOutput;
    setStatus(`采集完成：${items.length} 条`);
  } catch (error) {
    const message = error?.message || String(error);
    renderEmptyResult("采集失败，请查看日志。");
    renderLogs([`采集失败：${message}`]);
    setStatus(`采集失败：${message}`);
  } finally {
    setBusy(false);
  }
}

async function selectDxmRows() {
  const count = Number.parseInt(els.selectCountInput.value, 10);
  if (!Number.isFinite(count) || count <= 0) {
    renderLogs(["按数量选择失败：数量必须大于 0"]);
    setStatus("请输入大于 0 的选择数量");
    return;
  }

  setBusy(true);
  renderLogs([`开始按数量选择：${count}`]);
  setStatus("正在选择店小秘商品...");

  try {
    const response = await runInActiveTab(selectDxmRowsByCountInPage, [count]);
    renderLogs(response?.logs);
    setStatus(`选择完成：${response?.selected || 0}/${response?.requested || count}`);
  } catch (error) {
    const message = error?.message || String(error);
    renderLogs([`按数量选择失败：${message}`]);
    setStatus(`按数量选择失败：${message}`);
  } finally {
    setBusy(false);
  }
}

async function copyLatestOutput() {
  if (!latestOutput) return;

  try {
    await navigator.clipboard.writeText(latestOutput);
    setStatus("结果已复制");
  } catch (_error) {
    els.plainTextOutput.focus();
    els.plainTextOutput.select();
    document.execCommand("copy");
    setStatus("结果已复制");
  }
}

async function collectCategoryCorrectionsInPage() {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function normalizeText(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .trim();
  }

  function singleLine(text) {
    return normalizeText(text).replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
  }

  function isVisible(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  }

  function textOf(element) {
    return normalizeText(element?.innerText || element?.textContent || "");
  }

  function extractSkc(rowText) {
    return rowText.match(/SKC\s*ID\s*[:：]?\s*(\d+)/i)?.[1] || "";
  }

  function isAutoDiscardText(text) {
    return /\d+\s*天后自动废弃|天后自动废弃|自动废弃/.test(singleLine(text));
  }

  function findTextElements(regex) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const value = normalizeText(node.nodeValue);
        if (!value || !regex.test(value)) return NodeFilter.FILTER_REJECT;
        regex.lastIndex = 0;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const elements = [];
    let node = walker.nextNode();
    while (node) {
      if (node.parentElement && isVisible(node.parentElement)) elements.push(node.parentElement);
      node = walker.nextNode();
    }
    return elements;
  }

  function findRowFromElement(element) {
    const preferred = element.closest("tr,[role='row'],[class*='table-row'],[class*='TableRow'],[class*='semi-table-row'],[class*='beast-table-row']");
    if (preferred && /SKC\s*ID/i.test(textOf(preferred))) return preferred;

    let current = element;
    let fallback = null;
    for (let depth = 0; current && current !== document.body && depth < 12; depth += 1) {
      const text = textOf(current);
      const rect = current.getBoundingClientRect();
      if (/SKC\s*ID/i.test(text) && rect.width > 240 && rect.height > 30 && text.length < 6000) {
        fallback = current;
        if (/商品分类错误|分类错误待修正/.test(text)) return current;
      }
      current = current.parentElement;
    }
    return fallback;
  }

  function findErrorTag(row) {
    return Array.from(row.querySelectorAll("*"))
      .filter((element) => isVisible(element) && /商品分类错误待修正|分类错误待修正|商品分类错误/.test(singleLine(textOf(element))))
      .sort((a, b) => singleLine(textOf(a)).length - singleLine(textOf(b)).length)[0];
  }

  function uniqueRows(rows) {
    const seen = new Set();
    return rows.filter((row) => {
      const skc = extractSkc(textOf(row));
      const key = skc || textOf(row).slice(0, 120);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function findRows() {
    return uniqueRows(findTextElements(/SKC\s*ID/i).map(findRowFromElement).filter(Boolean)).filter((row) => findErrorTag(row));
  }

  function extractListing(row) {
    const lines = textOf(row).split(/\n+/).map(singleLine).filter(Boolean);
    const lineBeforeCategory = lines.find((line, index) => {
      const next = lines[index + 1] || "";
      return next.includes("类目") && !/SKC\s*ID|SPU\s*ID|货号|类目|商品分类错误|待修正|NEW|美国站/.test(line);
    });
    return lineBeforeCategory || lines.find((line) => line.length >= 8 && !/SKC\s*ID|SPU\s*ID|货号|类目|商品分类错误|待修正|NEW|美国站|复制/.test(line)) || "";
  }

  function dispatchHover(element) {
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    const options = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    ["pointerover", "mouseover", "pointerenter", "mouseenter", "mousemove"].forEach((eventName) => element.dispatchEvent(new MouseEvent(eventName, options)));
  }

  function dispatchLeave(element) {
    const options = { bubbles: true, cancelable: true, view: window };
    ["mouseout", "mouseleave", "pointerout", "pointerleave"].forEach((eventName) => element.dispatchEvent(new MouseEvent(eventName, options)));
  }

  function getHoverTargets(element, row) {
    const targets = [];
    let current = element;
    for (let depth = 0; current && current !== row && current !== document.body && depth < 5; depth += 1) {
      if (isVisible(current)) targets.push(current);
      current = current.parentElement;
    }
    return [...new Set(targets)];
  }

  function getPopoverCandidates() {
    return Array.from(document.body.querySelectorAll("[role='tooltip'],[role='dialog'],[class*='popover'],[class*='Popover'],[class*='tooltip'],[class*='Tooltip'],[class*='modal'],div"))
      .filter(isVisible)
      .map((element) => ({ element, text: textOf(element) }))
      .filter(({ text }) => text.length > 20 && text.length < 5000 && /修改建议/.test(text) && /当前类目/.test(text))
      .sort((a, b) => a.text.length - b.text.length);
  }

  async function waitForPopover(previousTexts) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 4000) {
      const candidate = getPopoverCandidates().find(({ text }) => !previousTexts.has(text));
      if (candidate) return candidate.text;
      await delay(100);
    }
    return getPopoverCandidates()[0]?.text || "";
  }

  function parseOriginalCategory(popoverText) {
    const match = normalizeText(popoverText).match(/当前类目\s*[:：]\s*([\s\S]*?)(?=\s*修改建议\s*[:：]|$)/);
    return singleLine(match?.[1] || "");
  }

  function parseSuggestions(popoverText) {
    const text = normalizeText(popoverText);
    const section = text.includes("修改建议") ? text.slice(text.indexOf("修改建议")).replace(/^修改建议\s*[:：]?/, "") : text;
    const markers = [];
    const markerRegex = /(?:^|\n|\s)([1-9])\s*[.。]\s*/g;
    let match = markerRegex.exec(section);
    while (match) {
      markers.push({ number: Number(match[1]), start: match.index, contentStart: markerRegex.lastIndex });
      match = markerRegex.exec(section);
    }
    const suggestions = [];
    markers.forEach((marker, index) => {
      if (marker.number < 1 || marker.number > 3) return;
      const next = markers[index + 1]?.start ?? section.length;
      suggestions[marker.number - 1] = singleLine(section.slice(marker.contentStart, next)).replace(/去修改\s*$/, "").trim();
    });
    return [suggestions[0] || "", suggestions[1] || "", suggestions[2] || ""];
  }

  async function readRowSuggestion(row) {
    const logs = [];
    const rowText = textOf(row);
    const errorTag = findErrorTag(row);
    const listing = extractListing(row);
    const skc = extractSkc(rowText);
    let popoverText = "";
    const previousTexts = new Set(getPopoverCandidates().map(({ text }) => text));

    for (const target of getHoverTargets(errorTag, row)) {
      logs.push(`尝试触发 hover：${skc || "未知 SKC"} / ${singleLine(textOf(target)).slice(0, 40)}`);
      dispatchHover(target);
      popoverText = await waitForPopover(previousTexts);
      dispatchLeave(target);
      if (popoverText) break;
      await delay(120);
    }

    const [suggestion1, suggestion2, suggestion3] = parseSuggestions(popoverText);
    const item = { listing, skc, originalCategory: parseOriginalCategory(popoverText), suggestion1, suggestion2, suggestion3 };
    logs.push(popoverText ? `已获取弹窗：${skc || "未知 SKC"}，建议数：${[suggestion1, suggestion2, suggestion3].filter(Boolean).length}` : `未获取到修改建议弹窗：${skc || "未知 SKC"}`);
    return { item, logs };
  }

  const logs = [];
  const rows = findRows();
  const items = [];
  logs.push(`找到候选商品行：${rows.length}`);

  for (const row of rows) {
    const rowText = textOf(row);
    if (isAutoDiscardText(rowText)) {
      logs.push(`遇到自动废弃标记，停止采集：${extractSkc(rowText) || "未知 SKC"}`);
      break;
    }

    const result = await readRowSuggestion(row);
    if (result.logs?.length) logs.push(...result.logs);
    if (result.item) items.push(result.item);
    await delay(120);
  }

  logs.push(`采集完成：${items.length} 条`);
  return { items, logs };
}

async function selectDxmRowsByCountInPage(requestedCount) {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function normalizeText(text) {
    return String(text || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function textOf(element) {
    return normalizeText(element?.innerText || element?.textContent || "");
  }

  function isVisible(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  }

  function getRows() {
    return Array.from(document.querySelectorAll("tr.pddkj-product-table-row, tr.vxe-body--row")).filter((row) => {
      if (!isVisible(row) || !row.querySelector("input[type='checkbox']")) return false;
      return /认领|Temu|CNY|创建|更新/.test(textOf(row));
    });
  }

  function getCheckbox(row) {
    return row.querySelector("td[colid='col_6'] input[type='checkbox'], input[type='checkbox']");
  }

  function isChecked(input) {
    const wrapper = input?.closest(".ant-checkbox, .vxe-checkbox, label");
    return Boolean(input?.checked || input?.getAttribute("aria-checked") === "true" || /checked|is--checked/.test(wrapper?.className || ""));
  }

  function rowLabel(row) {
    const title = textOf(row.querySelector(".white-space")) || textOf(row.querySelector("td[colid='col_8']"));
    const skc = textOf(row.querySelector("td[colid='col_10']")).match(/\b\d{8,}\b/)?.[0] || "";
    const spu = textOf(row.querySelector(".productUrl"));
    return [skc && `SKC ${skc}`, spu && `SPU ${spu}`, title].filter(Boolean).join(" / ").slice(0, 120) || "未知商品";
  }

  function firstRowKey() {
    const row = getRows()[0];
    return row?.getAttribute("rowid") || textOf(row).slice(0, 160);
  }

  function findPagerButton(title) {
    return Array.from(document.querySelectorAll(`button[title='${title}'], .vxe-pager button[title='${title}']`)).find((button) => {
      return isVisible(button) && !button.disabled && !/is--disabled|disabled/.test(button.className || "");
    });
  }

  async function waitForRows() {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5000) {
      const rows = getRows();
      if (rows.length) return rows;
      await delay(120);
    }
    return getRows();
  }

  async function waitForPageChange(previousKey) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 8000) {
      const key = firstRowKey();
      if (key && key !== previousKey && getRows().length) return true;
      await delay(150);
    }
    return false;
  }

  async function ensureChecked(row) {
    const checkbox = getCheckbox(row);
    if (!checkbox || checkbox.disabled) return { checked: false, reason: "没有可用复选框" };
    if (isChecked(checkbox)) return { checked: true, reason: "已选中" };

    checkbox.scrollIntoView({ block: "center", inline: "center" });
    await delay(40);
    checkbox.click();
    await delay(80);

    if (!isChecked(checkbox)) {
      (checkbox.closest("label, .ant-checkbox-wrapper, .vxe-cell") || checkbox).click();
      await delay(100);
    }
    return { checked: isChecked(checkbox), reason: isChecked(checkbox) ? "已点击选中" : "点击后仍未选中" };
  }

  const requested = Math.max(1, Math.floor(Number(requestedCount) || 0));
  const logs = [`目标选择数量：${requested}`];
  let selected = 0;
  let pageNumber = 1;
  const visitedPages = new Set();

  const firstButton = findPagerButton("首页");
  if (firstButton) {
    const previousKey = firstRowKey();
    firstButton.click();
    logs.push("已点击首页，准备从第一条开始选择");
    await waitForPageChange(previousKey);
    await delay(300);
  } else {
    logs.push("当前已经在第一页，或未找到可点击的首页按钮");
  }

  while (selected < requested) {
    const rows = await waitForRows();
    const pageKey = rows.map((row) => row.getAttribute("rowid") || textOf(row).slice(0, 60)).join("|");
    if (!rows.length) {
      logs.push("未找到店小秘商品行，请确认当前页面是数据搬家列表");
      break;
    }
    if (visitedPages.has(pageKey)) {
      logs.push("检测到分页内容未变化，停止选择，避免重复勾选");
      break;
    }
    visitedPages.add(pageKey);
    logs.push(`第 ${pageNumber} 页可选商品行：${rows.length}`);

    for (const row of rows) {
      if (selected >= requested) break;
      const result = await ensureChecked(row);
      if (result.checked) {
        selected += 1;
        logs.push(`已选择 ${selected}/${requested}：${rowLabel(row)}`);
      } else {
        logs.push(`选择失败：${rowLabel(row)}，原因：${result.reason}`);
      }
    }

    if (selected >= requested) break;
    const nextButton = findPagerButton("下一页");
    if (!nextButton) {
      logs.push(`没有下一页，已停止。实际选择：${selected}/${requested}`);
      break;
    }

    const previousKey = firstRowKey();
    nextButton.click();
    logs.push("已点击下一页，继续选择");
    if (!(await waitForPageChange(previousKey))) {
      logs.push("等待下一页加载超时，已停止");
      break;
    }
    pageNumber += 1;
    await delay(300);
  }

  logs.push(`按数量选择完成：${selected}/${requested}`);
  return { requested, selected, logs };
}
