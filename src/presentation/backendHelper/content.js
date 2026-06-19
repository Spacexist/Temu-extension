(function () {
  const PANEL_ID = "tc65-panel";
  const TARGET_PAGE_TEXT = ["合规中心", "商品合规信息", "加州 65", "包装材料信息收集", "适用年龄段"];

  const SCRIPT_VERSION = "workbench-20260620-4";
  if (window.__tc65HelperVersion === SCRIPT_VERSION) return;
  window.__tc65HelperVersion = SCRIPT_VERSION;
  window.__tc65HelperLoaded = true;

  const state = {
    running: false,
    stopRequested: false,
    drag: null,
    mode: "california65",
    autoConfirm: false,
    batchOnly: false
  };

  const FLOW_CONFIG = {
    california65: {
      title: "加州 65 批量助手",
      subtitle: "批量上传合规信息 / 待上传 / 无需警示"
    },
    packaging: {
      title: "包装信息批量助手",
      subtitle: "包装材料信息收集 / 待上传 / 包装字段"
    },
    age: {
      title: "年龄段批量助手",
      subtitle: "适用年龄段 / 待上传 / 18+"
    }
  };

  const selectIdByLabel = {
    "商品合规信息": "taskTypeList",
    "合规信息类型": "taskType",
    "状态": "taskStatusList"
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (value) => String(value || "").replace(/\s+/g, "").trim();

  function sendSidepanelMessage(payload) {
    try {
      if (chrome && chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage(payload).catch(() => {});
      }
    } catch (_error) {}
  }

  function installPageDebugBridge() {
    if (window.__TC65DebugBridgeInstalled) return;
    window.__TC65DebugBridgeInstalled = true;

    window.TC65_debugCall = async (method, ...args) => {
      if (method === "getPageSizeInfo") return window.TC65_getPageSizeInfo();
      if (method === "choosePageSize100") return window.TC65_choosePageSize100(...args);
      if (method === "fillPackagingInfo") return window.TC65_fillPackagingInfo(...args);
      if (method === "fillAgeInfo") return window.TC65_fillAgeInfo(...args);
      throw new Error(`未知调试方法：${method}`);
    };
  }
  function isUsefulPage() {
    return true;
  }

  function assertUsefulPage() {}

  function visible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      rect.width > 0 &&
      rect.height > 0;
  }

  function all(selector, root = document) {
    return [...root.querySelectorAll(selector)].filter(visible);
  }

  function textOf(el) {
    if (!el) return "";
    return norm(el.innerText || el.textContent || "");
  }

  function findByText(text, selector = "button, span, div, label, li, td, th") {
    const target = norm(text);
    const nodes = all(selector);
    return nodes.find((el) => textOf(el) === target) ||
      nodes.find((el) => textOf(el).includes(target));
  }

  function pluginModalVisible() {
    return [...document.querySelectorAll("#market-mate-for-1688-guidance, #plasmo-shadow-container, [class*='modal-bulk-inquiry']")]
      .some((el) => visible(el) && (el.innerText || "").includes("开始采集"));
  }

  function batchDialogRoot() {
    const dialogCandidates = [...document.querySelectorAll(".rocket-modal, .rocket-modal-content, .rocket-drawer, .rocket-drawer-content, [role='dialog']")]
      .filter(visible)
      .filter((el) => {
        const text = el.innerText || "";
        return text.includes("批量上传合规信息") &&
          Boolean(el.querySelector("input#taskType")) &&
          !text.includes("店小秘") &&
          !text.includes("开始采集");
      })
      .sort((a, b) => {
        const aHasStatus = a.querySelector("input#taskStatusList") ? 0 : 1;
        const bHasStatus = b.querySelector("input#taskStatusList") ? 0 : 1;
        if (aHasStatus !== bHasStatus) return aHasStatus - bHasStatus;
        const aHasPagination = a.querySelector(".rocket-pagination-options-size-changer, .rocket-pagination-options") ? 0 : 1;
        const bHasPagination = b.querySelector(".rocket-pagination-options-size-changer, .rocket-pagination-options") ? 0 : 1;
        if (aHasPagination !== bHasPagination) return aHasPagination - bHasPagination;
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (ar.width * ar.height) - (br.width * br.height);
      });

    if (dialogCandidates.length) return dialogCandidates[0];

    const taskType = selectInputById("taskType");
    if (!taskType) return null;

    let node = taskType.parentElement;
    let titleRoot = null;
    let paginationRoot = null;

    while (node && node !== document.documentElement) {
      const text = node.innerText || "";
      const hasBulkTitle = text.includes("批量上传合规信息");
      const hasTaskType = Boolean(node.querySelector("input#taskType"));
      const hasTaskStatus = Boolean(node.querySelector("input#taskStatusList"));
      const hasPagination = Boolean(node.querySelector(".rocket-pagination-options-size-changer, .rocket-pagination-options"));
      const isPluginPanel = text.includes("店小秘") || text.includes("开始采集") || text.includes("采集");

      if (hasBulkTitle && hasTaskType && !isPluginPanel) {
        titleRoot = node;
        if (hasTaskStatus && hasPagination) {
          paginationRoot = node;
          break;
        }
      }

      node = node.parentElement;
    }

    return paginationRoot ||
      titleRoot ||
      taskType.closest(".rocket-modal, .rocket-drawer, [role='dialog']") ||
      taskType.closest(".rocket-modal-content") ||
      taskType.closest(".rocket-drawer-content");
  }

  function nearestClickable(el) {
    if (!el) return null;
    return el.closest("button, label, li, [role='option'], .rocket-select-selector, .rocket-checkbox-wrapper") || el;
  }

  function nearestOption(el) {
    if (!el) return null;
    return el.closest(".rocket-select-item-option, .rocket-select-item, [role='option'], li") || el;
  }

  function selectInputByLabel(labelText) {
    const directId = selectIdByLabel[labelText];
    return directId ? selectInputById(directId) : null;
  }

  function selectInputById(inputId) {
    const escapedId = CSS.escape(inputId);
    const inputs = [...document.querySelectorAll(`input#${escapedId}`)].filter((input) => {
      const trigger = selectTriggerFromInput(input);
      return visible(trigger);
    });
    if (!inputs.length) return null;

    const inModal = inputs.filter((input) =>
      input.closest(".rocket-modal, .rocket-drawer, [role='dialog']") &&
      visible(input.closest(".rocket-modal, .rocket-drawer, [role='dialog']"))
    );

    const candidates = inModal.length ? inModal : inputs;
    return candidates[candidates.length - 1];
  }

  function selectRootFromInput(input) {
    if (!input) return null;
    return input.closest(".rocket-select") ||
      input.closest(".rocket-cascader") ||
      input.closest(".rocket-form-field-item") ||
      input.parentElement;
  }

  function selectTriggerFromInput(input) {
    const root = selectRootFromInput(input);
    return root?.querySelector(".rocket-select-selector") ||
      input.closest(".rocket-select-selector") ||
      input;
  }

  function selectedInSelectInput(input, optionText) {
    const root = selectRootFromInput(input);
    if (!root) return false;
    const target = norm(optionText);
    return selectedTitlesInSelectInput(input).some((title) => norm(title) === target);
  }

  function selectedTitlesInSelectInput(input) {
    const root = selectRootFromInput(input);
    if (!root) return [];
    return [...root.querySelectorAll(".rocket-select-selection-item")]
      .map((el) => el.getAttribute("title") || el.innerText || el.textContent || "")
      .map((title) => title.trim())
      .filter(Boolean);
  }

  function selectedInRoot(root, optionText) {
    if (!root) return false;
    const target = norm(optionText);
    return [...root.querySelectorAll(".rocket-select-selection-item")]
      .some((el) => norm(el.getAttribute("title") || el.textContent) === target);
  }

  async function waitForSelectInput(inputId, timeout = 3500) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const input = selectInputById(inputId);
      const root = selectRootFromInput(input);
      const disabled = input?.disabled || root?.classList.contains("rocket-select-disabled");
      if (input && !disabled) return input;
      await sleep(150);
    }
    return selectInputById(inputId);
  }

  function formItemByLabelText(labelText) {
    const target = norm(labelText);
    const labels = all("label, .rocket-form-field-item-label, div, span");
    const label = labels.find((el) => textOf(el) === target || textOf(el).includes(target));
    return label?.closest(".rocket-form-field-item") ||
      label?.closest(".rocket-row") ||
      label?.parentElement;
  }

  function selectedInSelectById(inputId, optionText) {
    const input = selectInputById(inputId);
    return selectedInSelectInput(input, optionText);
  }

  function selectedTitlesInSelectById(inputId) {
    const input = selectInputById(inputId);
    return selectedTitlesInSelectInput(input);
  }

  function dropdownVisible(dropdown) {
    if (!dropdown) return false;
    if (dropdown.classList.contains("rocket-select-dropdown-hidden")) return false;
    if ([...dropdown.classList].some((name) => name.includes("dropdown-hidden"))) return false;
    return visible(dropdown);
  }

  function dropdownForInput(input) {
    if (!input) return null;
    const listId = input.getAttribute("aria-controls") || input.getAttribute("aria-owns");
    if (listId) {
      const lists = [...document.querySelectorAll(`#${CSS.escape(listId)}`)].filter((list) => {
        const dropdown = list.closest(".rocket-select-dropdown") ||
          list.closest("[class*='select-dropdown']") ||
          list.parentElement;
        return dropdownVisible(dropdown);
      });
      const list = lists[lists.length - 1];
      const dropdown = list?.closest(".rocket-select-dropdown") ||
        list?.closest("[class*='select-dropdown']") ||
        list?.parentElement;
      if (dropdownVisible(dropdown)) return dropdown;
    }

    const dropdowns = all(".rocket-select-dropdown, [class*='select-dropdown']").filter(dropdownVisible);
    return dropdowns[dropdowns.length - 1] || null;
  }

  function optionInDropdown(input, optionText) {
    const dropdown = dropdownForInput(input) || document;
    const target = norm(optionText);
    const listId = input.getAttribute("aria-controls") || input.getAttribute("aria-owns");

    if (listId) {
      const byListId = all(`[id^="${CSS.escape(listId)}_"]`, dropdown).find((el) => textOf(el) === target);
      if (byListId) return byListId;
    }

    const titled = all("[title]", dropdown).find((el) => norm(el.getAttribute("title")) === target);
    if (titled) return titled;

    const options = all(".rocket-select-item-option, .rocket-select-item, [role='option'], li, div", dropdown);
    const matched = options.find((el) => textOf(el) === target) ||
      options.find((el) => textOf(el).includes(target));
    if (matched) return matched;

    return [...dropdown.querySelectorAll("*")]
      .filter((el) => visible(el.closest(".rocket-select-dropdown") || el))
      .find((el) => textOf(el) === target);
  }

  async function waitForDropdownOption(input, optionText, timeout = 2500) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const option = optionInDropdown(input, optionText);
      if (option) return option;
      await sleep(120);
    }
    return null;
  }

  async function clickAtCenter(el, name) {
    assertRunning();
    if (!el) throw new Error(`找不到：${name}`);
    el.scrollIntoView({ block: "center", inline: "center" });
    await sleep(180);

    const panel = document.getElementById(PANEL_ID);
    const previousPointerEvents = panel?.style.pointerEvents || "";
    const previousOpacity = panel?.style.opacity || "";
    if (panel) {
      panel.style.pointerEvents = "none";
      panel.style.opacity = "0.35";
    }

    try {
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const pointTarget = document.elementFromPoint(x, y) || el;
      const target = isSafeBatchTarget(pointTarget) ? pointTarget : el;
      assertSafeBatchClick(target, name);

      target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse" }));
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
      target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse" }));
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
    } finally {
      if (panel) {
        panel.style.pointerEvents = previousPointerEvents;
        panel.style.opacity = previousOpacity;
      }
    }

    log(`点击：${name}`, "ok");
    await sleep(650);
  }

  async function clickElementDirect(el, name) {
    assertRunning();
    if (!el) throw new Error(`找不到：${name}`);
    el.scrollIntoView({ block: "center", inline: "center" });
    await sleep(180);

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const init = { bubbles: true, cancelable: true, clientX: x, clientY: y };
    assertSafeBatchClick(el, name);

    el.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerId: 1, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mousedown", init));
    el.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerId: 1, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mouseup", init));
    el.dispatchEvent(new MouseEvent("click", init));
    el.click?.();

    log(`点击：${name}`, "ok");
    await sleep(650);
  }

  async function withPanelPassThrough(task) {
    const panel = document.getElementById(PANEL_ID);
    const previousPointerEvents = panel?.style.pointerEvents || "";
    const previousOpacity = panel?.style.opacity || "";
    if (panel) {
      panel.style.pointerEvents = "none";
      panel.style.opacity = "0.35";
    }

    try {
      return await task();
    } finally {
      if (panel) {
        panel.style.pointerEvents = previousPointerEvents;
        panel.style.opacity = previousOpacity;
      }
    }
  }

  async function chooseRocketSelectById(inputId, optionText, name = inputId) {
    let input = await waitForSelectInput(inputId, inputId === "taskStatusList" ? 7000 : 3500);
    if (!input) throw new Error(`找不到 select input：#${inputId}`);
    const root = selectRootFromInput(input);

    if (input.disabled || root?.classList.contains("rocket-select-disabled")) {
      throw new Error(`${name} 还没有解锁，无法选择：${optionText}`);
    }

    if (selectedInSelectById(inputId, optionText) || selectedInRoot(root, optionText)) {
      log(`已选择：${name} = ${optionText}`, "ok");
      return;
    }

    if (inputId === "taskStatusList" && (selectedTitlesInSelectById(inputId).map(norm).includes(norm(optionText)) || selectedInRoot(root, optionText))) {
      log(`已选择：${name} = ${optionText}`, "ok");
      return;
    }

    const trigger = selectTriggerFromInput(input);
    await clickAtCenter(trigger, `${name} 下拉框`);

    if (!input.hasAttribute("readonly")) {
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(input, optionText);
      else input.value = optionText;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: optionText }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(450);
    }

    if (inputId === "taskStatusList" && (selectedInSelectById(inputId, optionText) || selectedInRoot(selectRootFromInput(selectInputById(inputId)), optionText))) {
      log(`确认已选择：${name} = ${optionText}`, "ok");
      return;
    }

    const option = await waitForDropdownOption(input, optionText);
    if (!option) {
      const listId = input.getAttribute("aria-controls") || input.getAttribute("aria-owns") || "(无 list id)";
      throw new Error(`下拉已打开但找不到选项：${optionText}，list=${listId}`);
    }

    if (inputId === "taskStatusList" && (selectedInSelectById(inputId, optionText) || selectedInRoot(selectRootFromInput(selectInputById(inputId)), optionText))) {
      log(`确认已选择：${name} = ${optionText}`, "ok");
      return;
    }

    await clickAtCenter(nearestOption(option), `选项：${optionText}`);

    const started = Date.now();
    while (Date.now() - started < 1800) {
      if (selectedInSelectById(inputId, optionText)) {
        log(`确认已选择：${name} = ${optionText}`, "ok");
        return;
      }
      await sleep(120);
    }

    const titles = selectedTitlesInSelectById(inputId).join(", ") || "空";
    throw new Error(`未选上：${name} = ${optionText}；当前已选：${titles}`);
  }

  window.TC65_chooseRocketSelectById = chooseRocketSelectById;
  window.TC65_isRocketSelectSelected = (inputId, optionText) => {
    return selectedInSelectById(inputId, optionText);
  };
  window.TC65_findRocketSelectInput = selectInputById;
  window.TC65_getRocketSelectTitles = (inputId) => {
    return selectedTitlesInSelectById(inputId);
  };

  function setStatus(message) {
    const el = document.querySelector("#tc65-status");
    if (el) el.textContent = message;
    sendSidepanelMessage({ type: "backend-helper:status", message, level: "info" });
  }

  function log(message, level = "info") {
    const list = document.querySelector("#tc65-log");
    if (list) {
      const line = document.createElement("div");
      line.className = `tc65-log-line tc65-${level}`;
      line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
      list.appendChild(line);
      list.scrollTop = list.scrollHeight;
    }
    sendSidepanelMessage({ type: "backend-helper:log", message, level });
  }

  function assertRunning() {
    if (state.stopRequested) throw new Error("已停止");
  }

  function flowDone(message) {
    const error = new Error(message);
    error.name = "TC65_FLOW_DONE";
    throw error;
  }

  function dropdownBelongsToRoot(dropdown, root) {
    if (!dropdown || !root || !dropdownVisible(dropdown)) return false;
    const dropdownIds = [...dropdown.querySelectorAll("[id]")]
      .map((el) => el.id)
      .filter(Boolean);
    if (!dropdownIds.length) return false;

    return [...root.querySelectorAll("input[aria-controls], input[aria-owns]")]
      .some((input) => {
        const controls = input.getAttribute("aria-controls");
        const owns = input.getAttribute("aria-owns");
        return dropdownIds.includes(controls) || dropdownIds.includes(owns) ||
          dropdownIds.some((id) => controls && id.startsWith(`${controls}_`)) ||
          dropdownIds.some((id) => owns && id.startsWith(`${owns}_`));
      });
  }

  function isSafeBatchTarget(el) {
    if (!state.batchOnly) return true;
    if (!el) return false;
    if (el.closest(`#${PANEL_ID}`)) return true;

    const root = batchDialogRoot();
    if (!root) return false;
    if (root.contains(el)) return true;

    const dropdown = el.closest(".rocket-select-dropdown, [class*='select-dropdown']");
    return dropdownBelongsToRoot(dropdown, root);
  }

  function assertSafeBatchClick(el, name) {
    if (isSafeBatchTarget(el)) return;
    flowDone(`目标不在批量弹窗内，已停止：${name}`);
  }

  async function clickElement(el, name) {
    assertRunning();
    if (!el) throw new Error(`找不到：${name}`);
    const target = nearestClickable(el);
    assertSafeBatchClick(target, name);
    target.scrollIntoView({ block: "center", inline: "center" });
    await sleep(180);
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    target.click();
    log(`点击：${name}`, "ok");
    await sleep(750);
  }

  async function clickOptionElement(el, name) {
    assertRunning();
    const option = nearestOption(el);
    if (!option) throw new Error(`找不到：${name}`);
    option.scrollIntoView({ block: "center", inline: "center" });
    await sleep(220);

    const panel = document.getElementById(PANEL_ID);
    const previousPointerEvents = panel?.style.pointerEvents || "";
    const previousOpacity = panel?.style.opacity || "";
    if (panel) {
      panel.style.pointerEvents = "none";
      panel.style.opacity = "0.35";
    }

    try {
      const rect = option.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const pointTarget = document.elementFromPoint(x, y) || option;
      const target = isSafeBatchTarget(pointTarget) ? pointTarget : option;
      assertSafeBatchClick(target, name);

      target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse" }));
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
      target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse" }));
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
    } finally {
      if (panel) {
        panel.style.pointerEvents = previousPointerEvents;
        panel.style.opacity = previousOpacity;
      }
    }

    log(`点击：${name}`, "ok");
    await sleep(850);
  }

  async function clickText(text) {
    const el = findByText(text, "button, span, div, li");
    await clickElement(el, text);
  }

  async function openBatchUploadDialog() {
    assertRunning();

    const existing = batchDialogRoot();
    if (existing && existing.querySelector("input#taskType")) {
      state.batchOnly = true;
      log("批量上传弹窗已打开", "ok");
      return;
    }

    const targetText = norm("批量上传合规信息");
    const buttons = all("button")
      .filter((button) => !button.closest(`#${PANEL_ID}`))
      .filter((button) => !button.closest("#market-mate-for-1688-guidance, #plasmo-shadow-container, [id*='yqcj'], [class*='modal-bulk-inquiry']"))
      .filter((button) => {
        const text = textOf(button);
        const spanText = textOf(button.querySelector("span"));
        return text === targetText || spanText === targetText;
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.top - br.top || ar.left - br.left;
      });

    const button = buttons[0];
    if (!button) {
      throw new Error("找不到主内容区的“批量上传合规信息”按钮，已停止以避免误点");
    }

    await clickElement(button, "批量上传合规信息");

    const started = Date.now();
    while (Date.now() - started < 3500) {
      const root = batchDialogRoot();
      if (root && root.querySelector("input#taskType")) {
        state.batchOnly = true;
        return;
      }
      await sleep(150);
    }

    throw new Error("点击后未打开批量上传弹窗，已停止");
  }

  function findFormItemByLabel(labelText) {
    const directInput = selectInputByLabel(labelText);
    if (directInput) {
      return directInput.closest(".rocket-form-field-item") ||
        directInput.closest(".rocket-row") ||
        directInput.closest(".rocket-select") ||
        directInput.parentElement;
    }

    const label = findByText(labelText, "label, div, span");
    if (!label) return null;
    return label.closest(".rocket-form-field-item") ||
      label.closest(".rocket-row") ||
      label.parentElement?.parentElement?.parentElement ||
      label.parentElement;
  }

  async function openSelectByLabel(labelText) {
    const directInput = selectInputByLabel(labelText);
    if (directInput) {
      const directSelector = directInput.closest(".rocket-select")?.querySelector(".rocket-select-selector") ||
        directInput.closest(".rocket-select-selector") ||
        directInput;
      await clickElement(directSelector, `${labelText} 下拉框`);
      return;
    }

    const item = findFormItemByLabel(labelText);
    if (!item) throw new Error(`找不到筛选项：${labelText}`);
    const selector = item.querySelector(".rocket-select-selector") ||
      item.querySelector("[role='combobox']") ||
      item.querySelector("input");
    await clickElement(selector, `${labelText} 下拉框`);
  }

  function selectedInItem(labelText, optionText) {
    const item = findFormItemByLabel(labelText);
    if (!item) return false;
    const selected = all(".rocket-select-selection-item", item);
    return selected.some((el) => {
      const title = norm(el.getAttribute("title"));
      return title === norm(optionText) || textOf(el) === norm(optionText);
    });
  }

  async function waitForSelected(labelText, optionText, timeout = 1800) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (selectedInItem(labelText, optionText)) return true;
      await sleep(120);
    }
    return false;
  }

  async function searchSelectOption(labelText, optionText) {
    const item = findFormItemByLabel(labelText);
    const input = selectInputByLabel(labelText) || item?.querySelector(".rocket-select-selection-search-input, input[role='combobox'], input");
    if (!input) return;
    if (input.hasAttribute("readonly")) return;

    await clickElement(input, `${labelText} 输入框`);
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, optionText);
    else input.value = optionText;

    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: optionText }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(650);
  }

  async function pressEnterOnSelect(labelText) {
    const item = findFormItemByLabel(labelText);
    const input = selectInputByLabel(labelText) || item?.querySelector(".rocket-select-selection-search-input, input[role='combobox'], input");
    if (!input) return;
    if (input.hasAttribute("readonly")) return;

    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }));
    await sleep(700);
  }

  async function inputSelect(labelText, optionText) {
    setStatus(`输入 ${labelText}：${optionText}`);
    await openSelectByLabel(labelText);
    await searchSelectOption(labelText, optionText);
    await pressEnterOnSelect(labelText);
  }

  async function chooseDropdownOption(optionText) {
    await sleep(500);
    const option = findByText(
      optionText,
      ".rocket-select-item-option, .rocket-select-item, [role='option'], div, span, li"
    );
    await clickOptionElement(option, `选项：${optionText}`);
  }

  async function chooseSelect(labelText, optionText) {
    const directInput = selectInputByLabel(labelText);
    if (directInput) {
      await chooseRocketSelectById(directInput.id, optionText, labelText);
      return;
    }

    if (selectedInItem(labelText, optionText)) {
      log(`已选择：${labelText} = ${optionText}`, "ok");
      return;
    }

    await inputSelect(labelText, optionText);

    if (await waitForSelected(labelText, optionText)) {
      log(`确认已选择：${optionText}`, "ok");
      return;
    }

    await chooseDropdownOption(optionText);

    if (await waitForSelected(labelText, optionText)) {
      log(`确认已选择：${optionText}`, "ok");
      return;
    }

    log(`第一次未检测到已选择，重试：${optionText}`, "warn");
    await inputSelect(labelText, optionText);
    await chooseDropdownOption(optionText);

    if (!(await waitForSelected(labelText, optionText, 2200))) {
      throw new Error(`未选上：${labelText} = ${optionText}`);
    }

    log(`确认已选择：${optionText}`, "ok");
  }

  async function clickQueryIfPresent() {
    const root = batchDialogRoot();
    if (!root) {
      log("批量上传弹窗已关闭，停止后续操作", "warn");
      return false;
    }
    const buttons = all("button", root);
    const queryButtons = buttons.filter((button) => {
      const text = textOf(button);
      const spanText = textOf(button.querySelector("span"));
      return text === "查询" || text === "查詢" || spanText === "查询" || spanText === "查詢";
    });

    const primary = queryButtons.find((button) =>
      button.classList.contains("rocket-btn-primary")
    );

    const query = primary || queryButtons[queryButtons.length - 1];
    if (!query) {
      log("找不到批量上传弹窗里的查询按钮，停止后续操作", "warn");
      return false;
    }
    await clickElement(query, "查询");
    await waitForBatchTableAfterQuery();
    return true;
  }

  window.TC65_clickQuery = clickQueryIfPresent;

  async function choosePageSize100(options = {}) {
    const optional = Boolean(options.optional);

    if (pluginModalVisible()) {
      throw new Error("检测到店小秘采集弹窗已打开，请先关闭该弹窗后重试");
    }

    const findPageSizeSelect = () => {
      const root = batchDialogRoot();
      if (!root) return null;

      const paginationSelects = [...root.querySelectorAll(".rocket-pagination-options .rocket-pagination-options-size-changer, .rocket-pagination-options-size-changer")]
        .filter(visible)
        .filter((select) => !select.closest(`#${PANEL_ID}`))
        .filter((select) => !select.closest("#market-mate-for-1688-guidance, #plasmo-shadow-container, [id*='yqcj'], [class*='modal-bulk-inquiry']"))
        .filter((select) => {
          const item = select.querySelector(".rocket-select-selection-item");
          return norm(item?.getAttribute("title") || item?.textContent).includes("条/页");
        })
        .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);

      if (paginationSelects.length) return paginationSelects[0];

      const rocketPageSelects = [...root.querySelectorAll(".rocket-select")]
        .filter(visible)
        .filter((select) => !select.closest(`#${PANEL_ID}`))
        .filter((select) => !select.closest("#market-mate-for-1688-guidance, #plasmo-shadow-container, [id*='yqcj'], [class*='modal-bulk-inquiry']"))
        .filter((select) => {
          const input = select.querySelector("input.rocket-select-selection-search-input[id^='rocket_select_']");
          const item = select.querySelector(".rocket-select-selection-item");
          return Boolean(input) && norm(item?.getAttribute("title") || item?.textContent).includes("条/页");
        })
        .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);

      if (rocketPageSelects.length) return rocketPageSelects[0];

      const selectedItems = [...root.querySelectorAll(".rocket-select-selection-item")]
        .filter(visible)
        .filter((item) => item.closest(".rocket-select")?.querySelector("input.rocket-select-selection-search-input[id^='rocket_select_']"))
        .filter((item) => norm(item.getAttribute("title") || item.textContent).includes("条/页"));

      return selectedItems
        .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)
        .at(0)?.closest(".rocket-select") || null;
    };

    const pageSizeTitles = () => {
      const select = findPageSizeSelect();
      if (!select) return [];
      return [...select.querySelectorAll(".rocket-select-selection-item")]
        .map((el) => el.getAttribute("title") || el.textContent || "")
        .map(norm)
        .filter(Boolean);
    };

    const isPageSize100 = () => pageSizeTitles().includes("100条/页");

    const sendSelectKey = async (target, key, code = key, keyCode = 0) => {
      if (!target) return;
      target.focus?.();
      const eventInit = {
        bubbles: true,
        cancelable: true,
        key,
        code,
        keyCode,
        which: keyCode
      };
      target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
      await sleep(80);
      target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
      await sleep(120);
    };

    const keyboardChoose100 = async (input, trigger) => {
      await clickAtCenter(trigger, "条/页 下拉框");
      await sleep(250);
      const keyTarget = input || trigger;
      await sendSelectKey(keyTarget, "End", "End", 35);
      await sendSelectKey(keyTarget, "Enter", "Enter", 13);

      const started = Date.now();
      while (Date.now() - started < 2200) {
        if (isPageSize100()) {
          log("确认已选择：100 条/页", "ok");
          return "changed";
        }
        await sleep(120);
      }

      log("End+Enter 未生效，尝试 ArrowDown 逐项选择", "warn");
      await clickAtCenter(trigger, "条/页 下拉框");
      await sleep(300);
      for (let i = 0; i < 4; i++) {
        await sendSelectKey(keyTarget, "ArrowDown", "ArrowDown", 40);
      }
      await sendSelectKey(keyTarget, "Enter", "Enter", 13);

      const started2 = Date.now();
      while (Date.now() - started2 < 2200) {
        if (isPageSize100()) {
          log("确认已选择：100 条/页", "ok");
          return "changed";
        }
        await sleep(120);
      }
      return null;
    };

    let pageSizeSelector = null;
    const findStarted = Date.now();
    const findTimeout = optional ? 800 : 3500;
    while (Date.now() - findStarted < findTimeout) {
      pageSizeSelector = findPageSizeSelect();
      if (pageSizeSelector) break;
      await sleep(200);
    }

    if (!pageSizeSelector) {
      if (optional) {
        log("当前未渲染条/页分页选择器，查询后再重试", "warn");
        return null;
      }
      throw new Error("未找到条/页分页选择器");
    }

    if (isPageSize100()) {
      log("已是 100 条/页", "ok");
      return "already";
    }

    const input = pageSizeSelector.querySelector("input[role='combobox'], input");
    const inputId = input?.id || "";
    const listId = input?.getAttribute("aria-controls") || input?.getAttribute("aria-owns") || "";
    const trigger = pageSizeSelector.querySelector(".rocket-select-selector") || pageSizeSelector;
    const panel = document.getElementById(PANEL_ID);
    const previousPointerEvents = panel?.style.pointerEvents || "";
    const previousOpacity = panel?.style.opacity || "";
    if (panel) {
      panel.style.pointerEvents = "none";
      panel.style.opacity = "0.35";
    }

    try {
    await clickAtCenter(trigger, "条/页 下拉框");
    input?.focus?.();
    input?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40 }));
    await sleep(250);

    const started = Date.now();
    let option = null;
    while (Date.now() - started < 2500) {
      const list = listId ? document.getElementById(listId) : null;
      const dropdown = list?.closest(".rocket-select-dropdown") ||
        list?.closest("[class*='select-dropdown']") ||
        dropdownForInput(input) ||
        all(".rocket-select-dropdown, [class*='select-dropdown']")
          .filter(dropdownVisible)
          .filter((dropdownEl) => !dropdownEl.closest("#market-mate-for-1688-guidance, #plasmo-shadow-container, [id*='yqcj'], [class*='modal-bulk-inquiry']"))
          .at(-1);
      if (dropdown) {
        option = [...dropdown.querySelectorAll(".rocket-select-item-option")]
          .filter(visible)
          .find((el) => norm(el.getAttribute("title") || el.textContent) === "100条/页");

        if (!option) {
          option = [...dropdown.querySelectorAll("[role='option']")]
            .find((el) => norm(el.getAttribute("aria-label") || el.textContent) === "100条/页");
        }
      }
      if (option) break;
      await sleep(120);
    }

    if (!option) {
      if (isPageSize100()) {
        log("确认已选择：100 条/页", "ok");
        return "changed";
      }
      log("未找到真实 100 条/页选项，尝试键盘选择", "warn");
      if (await keyboardChoose100(input, trigger)) return "changed";
      throw new Error("未找到真实的 100 条/页选项，键盘选择也未生效");
    }

    await clickAtCenter(nearestOption(option), "100 条/页");
    const waitStarted = Date.now();
    while (Date.now() - waitStarted < 2500) {
      if (isPageSize100()) {
        log("确认已选择：100 条/页", "ok");
        return "changed";
      }
      await sleep(120);
    }

    log("点击 100 条/页未生效，尝试键盘选择", "warn");
    const currentInput = inputId ? document.getElementById(inputId) : input;
    const currentTrigger = currentInput?.closest(".rocket-select")?.querySelector(".rocket-select-selector") || trigger;
    if (await keyboardChoose100(currentInput, currentTrigger)) return "changed";

    const finalTitles = pageSizeTitles();
    if (finalTitles.includes("100条/页")) {
      log("确认已选择：100 条/页", "ok");
      return "changed";
    }

    throw new Error(`未能选择 100 条/页，当前分页：${finalTitles.join(", ") || "未知"}`);
    } finally {
      if (panel) {
        panel.style.pointerEvents = previousPointerEvents;
        panel.style.opacity = previousOpacity;
      }
    }
  }

  window.TC65_choosePageSize100 = choosePageSize100;
  window.TC65_getPageSizeInfo = () => {
    const root = batchDialogRoot();
    if (!root) return [];
    const items = [...root.querySelectorAll(".rocket-select-selection-item")]
      .filter(visible)
      .filter((item) => !item.closest("#market-mate-for-1688-guidance, #plasmo-shadow-container, [id*='yqcj'], [class*='modal-bulk-inquiry']"))
      .filter((item) => item.closest(".rocket-pagination-options") || item.closest(".rocket-select")?.querySelector("input.rocket-select-selection-search-input[id^='rocket_select_']"))
      .filter((item) => norm(item.getAttribute("title") || item.textContent).includes("条/页"))
      .map((item) => {
        const select = item.closest(".rocket-select");
        const input = select?.querySelector("input[role='combobox'], input");
        const rect = select?.getBoundingClientRect();
        return {
          title: item.getAttribute("title") || item.textContent || "",
          inputId: input?.id || "",
          listId: input?.getAttribute("aria-controls") || input?.getAttribute("aria-owns") || "",
          source: item.closest(".rocket-pagination-options") ? "pagination" : "rocket_select",
          top: rect ? Math.round(rect.top) : null,
          left: rect ? Math.round(rect.left) : null
        };
      });
    return items;
  };

  async function waitForBatchTableAfterQuery(timeout = 3500) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const root = batchDialogRoot();
      if (!root) return false;
      const text = root.innerText || "";
      if (text.includes("总共") || text.includes("请选择商品") || text.includes("暂无数据")) return true;
      await sleep(150);
    }
    return false;
  }

  async function hasNoProducts() {
    const started = Date.now();
    const timeout = 3000;
    while (Date.now() - started < timeout) {
      const root = batchDialogRoot();
      if (!root) {
        log("批量上传弹窗已关闭，按完成处理", "warn");
        return true;
      }
      const rows = [...root.querySelectorAll("tbody tr.rocket-table-row")].filter(visible);
      if (rows.length > 0) return false;

      const text = root.innerText || "";
      if (text.includes("暂无数据")) {
        await sleep(300);
        const root2 = batchDialogRoot();
        if (!root2) return true;
        const text2 = root2.innerText || "";
        if (text2.includes("暂无数据")) return true;
      }
      const totalMatch = text.match(/总共\s*(\d+)\s*条/);
      if (totalMatch && Number(totalMatch[1]) === 0) {
        await sleep(300);
        const root2 = batchDialogRoot();
        if (!root2) return true;
        const text2 = root2.innerText || "";
        const totalMatch2 = text2.match(/总共\s*(\d+)\s*条/);
        if (totalMatch2 && Number(totalMatch2[1]) === 0) return true;
      }
      await sleep(200);
    }

    const root = batchDialogRoot();
    if (!root) return true;
    const text = root.innerText || "";
    if (text.includes("暂无数据")) return true;
    const totalMatch = text.match(/总共\s*(\d+)\s*条/);
    if (totalMatch && Number(totalMatch[1]) === 0) return true;
    return false;
  }

  async function selectAllRows() {
    setStatus("全选商品");
    const root = batchDialogRoot();
    if (!root) {
      log("批量上传弹窗已关闭，已完成", "warn");
      return false;
    }
    const tables = all(".rocket-table-wrapper, table", root)
      .filter((table) => (table.innerText || "").includes("商品信息"));
    const tableRoot = tables.at(-1) || root;
    const headerInput = all("thead input[type='checkbox']", tableRoot)
      .find((input) => !input.checked && !input.disabled);

    if (headerInput) {
      await clickElement(headerInput.closest("label") || headerInput, "全选 checkbox");
      await waitForSelectedRows();
      return true;
    }

    const checkbox = all("thead .rocket-checkbox-wrapper, thead .rocket-checkbox", tableRoot)
      .find((el) => !el.className.includes("checked"));

    if (!checkbox) {
      log("没有找到全选 checkbox，已完成", "warn");
      return false;
    }

    await clickElement(checkbox, "全选 checkbox");
    await waitForSelectedRows();
    return true;
  }

  async function waitForSelectedRows(timeout = 2500) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const root = batchDialogRoot();
      if (!root) return false;
      const text = root.innerText || "";
      const match = text.match(/已选：\s*(\d+)/);
      if (match && Number(match[1]) > 0) return true;
      if (root.querySelector(".rocket-table-row-selected, .rocket-checkbox-checked")) return true;
      await sleep(120);
    }
    log("全选后未检测到已选商品", "warn");
    return false;
  }

  async function chooseNoWarning() {
    setStatus("输入警示类型：无需警示");

    const warningOptionText = "No Warning Applicable/无需警示";
    const root = batchDialogRoot();
    if (!root) {
      log("批量上传弹窗已关闭，跳过警示类型", "warn");
      return;
    }
    const californiaSection = [...root.querySelectorAll("div")]
      .filter(visible)
      .filter((el) => (el.innerText || "").includes("加利福尼亚州65号法案"))
      .sort((a, b) => (a.innerText || "").length - (b.innerText || "").length)
      .at(0)?.parentElement || root;

    const warningItem = [...all(".rocket-form-field-item, .rocket-row", californiaSection)]
      .reverse()
      .find((el) => textOf(el).includes("警示类型")) ||
      [...all(".rocket-form-field-item, .rocket-row", root)]
        .reverse()
        .find((el) => textOf(el).includes("警示类型") && el.getBoundingClientRect().top > (selectInputById("taskStatusList")?.getBoundingClientRect().top || 0));

    if (selectedInRoot(warningItem, warningOptionText)) {
      log("已选择：警示类型 = 无需警示", "ok");
      return;
    }

    if (!warningItem) {
      log("未找到警示类型下拉框，跳过", "warn");
      return;
    }

    const input = warningItem.querySelector(".rocket-select-selection-search-input, input[role='combobox'], input");
    const selector = warningItem.querySelector(".rocket-select-selector") || input;
    await clickElement(selector, "警示类型输入框");

    if (selectedInRoot(warningItem, warningOptionText)) {
      log("确认已选择：警示类型 = 无需警示", "ok");
      return;
    }

    if (input) {
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(input, warningOptionText);
      else input.value = warningOptionText;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: warningOptionText }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(700);
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }));
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }));
      await sleep(700);
    }

    if (selectedInRoot(warningItem, warningOptionText)) {
      log("确认已选择：警示类型 = 无需警示", "ok");
      return;
    }

    const noWarning = input ? await waitForDropdownOption(input, warningOptionText, 1200) : null;

    if (selectedInRoot(warningItem, warningOptionText)) {
      log("确认已选择：警示类型 = 无需警示", "ok");
      return;
    }

    if (!noWarning) {
      log("未找到无需警示选项，跳过", "warn");
      return;
    }

    await clickOptionElement(noWarning, "无需警示");
  }

  function packagingRoot() {
    const tableRoot = document.getElementById("166");
    if (tableRoot) return tableRoot;

    const title = [...document.querySelectorAll("div, span")]
      .filter(visible)
      .filter((el) => (el.innerText || "").includes("商品包装材质信息收集"))
      .sort((a, b) => (a.innerText || "").length - (b.innerText || "").length)
      .at(0);

    return title?.parentElement ||
      batchDialogRoot() ||
      document;
  }

  async function waitForPackagingFields(timeout = 4500) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const root = packagingRoot();
      if (root.querySelector("input[id='166List_0_list_0_1100100460']")) return root;
      await sleep(150);
    }
    throw new Error("找不到包装信息填写区域");
  }

  function inputNumberValue(input) {
    return String(input?.value || "").trim();
  }

  async function fillNumberById(inputId, value, name) {
    const started = Date.now();
    let input = null;
    while (Date.now() - started < 3500) {
      input = document.getElementById(inputId);
      if (input && visible(input) && !input.disabled) break;
      await sleep(150);
    }

    if (!input) throw new Error(`找不到输入框：${name}`);
    if (input.disabled) throw new Error(`${name} 还没有解锁，无法输入`);
    if (inputNumberValue(input) === value) {
      log(`已填写：${name} = ${value}`, "ok");
      return;
    }

    input.scrollIntoView({ block: "center", inline: "center" });
    await sleep(180);
    input.focus();

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;

    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await sleep(400);

    if (inputNumberValue(input) !== value) {
      throw new Error(`未填上：${name} = ${value}；当前值：${inputNumberValue(input) || "空"}`);
    }

    log(`填写：${name} = ${value}`, "ok");
  }

  async function fillPackagingInfo() {
    setStatus("填写包装信息");
    await waitForPackagingFields();

    await chooseRocketSelectById("166List_0_list_0_1100100460", "塑料", "材质分类");
    await chooseRocketSelectById("166List_0_list_0_1100100461", "聚乙烯", "材料名称");
    await chooseRocketSelectById("166List_0_list_0_1100100475", "是", "它是否含有一次性塑料");
    await chooseRocketSelectById("166List_0_list_0_1100100463", "其他包装类型", "包装类型");
    await fillNumberById("166List_0_list_0_1100100464", "10.00", "包装材料重量");
  }

  window.TC65_fillPackagingInfo = fillPackagingInfo;

  async function waitForAgeFields(timeout = 4500) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const input = document.getElementById("23_1000100038");
      if (input && visible(selectTriggerFromInput(input))) return input;
      await sleep(150);
    }
    throw new Error("找不到适用年龄段填写区域");
  }

  async function fillAgeInfo() {
    setStatus("填写适用年龄段：18+");
    await waitForAgeFields();
    await chooseRocketSelectById("23_1000100038", "18+", "适用年龄段");
  }

  window.TC65_fillAgeInfo = fillAgeInfo;

  async function checkDeclaration() {
    const root = batchDialogRoot();
    if (!root) {
      log("批量上传弹窗已关闭，跳过声明确认", "warn");
      return;
    }
    const label = [...root.querySelectorAll("label")]
      .filter(visible)
      .find((el) => (el.innerText || "").includes("我确认所提供的所有材料"));

    const checkbox = label?.querySelector("input[type='checkbox']") ||
      label?.closest(".rocket-checkbox-wrapper")?.querySelector("input[type='checkbox']");

    if (checkbox?.checked) {
      log("已勾选：声明确认", "ok");
      return;
    }

    if (label) {
      await clickElement(label, "声明确认 checkbox");
      return;
    }

    const row = [...root.querySelectorAll("div, span")]
      .filter(visible)
      .find((el) => (el.innerText || "").includes("我确认所提供的所有材料"));
    const rowCheckbox = row?.querySelector("input[type='checkbox']") ||
      row?.closest("div")?.querySelector("input[type='checkbox']");

    if (rowCheckbox?.checked) {
      log("已勾选：声明确认", "ok");
      return;
    }

    if (rowCheckbox) {
      await clickElement(rowCheckbox.closest("label") || rowCheckbox, "声明确认 checkbox");
      return;
    }

    log("未找到底部声明确认 checkbox，跳过", "warn");
  }

  async function maybeConfirmUpload() {
    if (!state.autoConfirm) {
      log("已停在确认上传前，请人工检查后提交。", "warn");
      return;
    }

    const root = batchDialogRoot();
    if (!root) {
      log("批量上传弹窗已关闭，跳过确认上传", "warn");
      return;
    }
    const buttons = all("button", root).filter((button) => {
      const text = textOf(button);
      const spanText = textOf(button.querySelector("span"));
      return text === "确认上传" || spanText === "确认上传";
    });
    const primary = buttons.find((button) => button.classList.contains("rocket-btn-primary"));
    const button = primary || buttons.at(-1);
    if (!button) {
      log("未找到确认上传按钮，跳过", "warn");
      return;
    }

    await clickElement(button, "确认上传");
  }

  async function queryWithPageSize100() {
    const beforeQuery = await choosePageSize100({ optional: true });
    if (!(await clickQueryIfPresent())) return false;
    await sleep(1000);

    const afterQuery = await choosePageSize100();
    if (afterQuery === "changed" || beforeQuery === null) {
      log("100 条/页已生效，重新查询列表", "ok");
      if (!(await clickQueryIfPresent())) return false;
      await sleep(1000);
    }
    return true;
  }

  async function runCalifornia65Flow() {
    log("开始执行加州 65 批量流程", "ok");

    await openBatchUploadDialog();
    await chooseSelect("合规信息类型", "加州 65 号提案");
    await chooseSelect("状态", "待上传");
    if (!(await queryWithPageSize100())) return;
    if (await hasNoProducts()) {
      log("没有待上传的商品，已完成", "ok");
      return;
    }
    if (!(await selectAllRows())) return;
    await chooseNoWarning();
    await checkDeclaration();
    await maybeConfirmUpload();
  }

  async function runPackagingFlow() {
    log("开始执行包装信息批量流程", "ok");

    await openBatchUploadDialog();
    await chooseSelect("合规信息类型", "包装材料信息收集");
    await chooseSelect("状态", "待上传");
    if (!(await queryWithPageSize100())) return;
    if (await hasNoProducts()) {
      log("没有待上传的商品，已完成", "ok");
      return;
    }
    if (!(await selectAllRows())) return;
    await fillPackagingInfo();
    await checkDeclaration();
    await maybeConfirmUpload();
  }

  async function runAgeFlow() {
    log("开始执行年龄段批量流程", "ok");

    await openBatchUploadDialog();
    await chooseSelect("合规信息类型", "适用年龄段");
    await chooseSelect("状态", "待上传");
    if (!(await queryWithPageSize100())) return;
    if (await hasNoProducts()) {
      log("没有待上传的商品，已完成", "ok");
      return;
    }
    if (!(await selectAllRows())) return;
    await fillAgeInfo();
    await checkDeclaration();
    await maybeConfirmUpload();
  }

  function selectedMode() {
    return document.querySelector("#tc65-flow-mode")?.value || state.mode || "california65";
  }

  function applyMode(mode) {
    state.mode = ["packaging", "age"].includes(mode) ? mode : "california65";
    const config = FLOW_CONFIG[state.mode];
    const title = document.querySelector("#tc65-flow-title");
    const subtitle = document.querySelector("#tc65-flow-subtitle");
    const modeSelect = document.querySelector("#tc65-flow-mode");
    if (title) title.textContent = config.title;
    if (subtitle) subtitle.textContent = config.subtitle;
    if (modeSelect) modeSelect.value = state.mode;
  }

  async function runFlow(mode = selectedMode()) {
    if (state.running) return;

    state.running = true;
    state.stopRequested = false;
    applyMode(mode);
    updateButtons();

    try {
      assertUsefulPage();
      setStatus("开始处理");
      if (state.mode === "packaging") await runPackagingFlow();
      else if (state.mode === "age") await runAgeFlow();
      else await runCalifornia65Flow();

      setStatus("完成");
      log("流程完成", "ok");
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (error?.name === "TC65_FLOW_DONE") {
        setStatus("完成");
        log(message, "warn");
      } else {
        setStatus(message);
        log(message, state.stopRequested ? "warn" : "error");
      }
    } finally {
      state.running = false;
      state.stopRequested = false;
      state.batchOnly = false;
      updateButtons();
    }
  }

  function updateButtons() {
    const start = document.querySelector("#tc65-start");
    const stop = document.querySelector("#tc65-stop");
    if (start) start.disabled = state.running;
    if (stop) stop.disabled = !state.running;
  }

  function bindDrag(panel) {
    const header = panel.querySelector(".tc65-header");
    header.addEventListener("mousedown", (event) => {
      if (event.target.closest("button")) return;
      const rect = panel.getBoundingClientRect();
      state.drag = {
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top
      };
      event.preventDefault();
    });

    document.addEventListener("mousemove", (event) => {
      if (!state.drag) return;
      const left = Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, event.clientX - state.drag.offsetX));
      const top = Math.max(8, Math.min(window.innerHeight - panel.offsetHeight - 8, event.clientY - state.drag.offsetY));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = "auto";
    });

    document.addEventListener("mouseup", () => {
      state.drag = null;
    });
  }

  function createPanel() {
    document.getElementById(PANEL_ID)?.remove();
  }

  function showPanel() {
    document.getElementById(PANEL_ID)?.remove();
  }

  function setAutoConfirm(value) {
    state.autoConfirm = Boolean(value);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) return false;

    if (message.type === "TC65_STATUS" || message.type === "TC65_WORKBENCH_STATUS") {
      showPanel();
      sendResponse({
        ok: true,
        usable: isUsefulPage(),
        message: "助手已就绪，可在当前网页执行。"
      });
      return false;
    }

    if (message.type === "TC65_SHOW_PANEL" || message.type === "TC65_WORKBENCH_SHOW_PANEL") {
      showPanel();
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "TC65_RUN" || message.type === "TC65_WORKBENCH_RUN") {
      log(`收到侧边栏启动请求：${message.mode || state.mode}`, "ok");
      applyMode(message.mode);
      setAutoConfirm(message.autoConfirm);
      runFlow(message.mode);
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "TC65_STOP" || message.type === "TC65_WORKBENCH_STOP") {
      showPanel();
      state.stopRequested = true;
      setStatus("正在停止");
      log("收到侧边栏停止请求", "warn");
      updateButtons();
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  if (document.documentElement) {
    installPageDebugBridge();
    createPanel();
  }
})();







