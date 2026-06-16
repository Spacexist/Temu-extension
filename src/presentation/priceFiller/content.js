(function () {
  if (window.__TEMU_PRICE_FILLER_WORKBENCH_LOADED__) return;
  window.__TEMU_PRICE_FILLER_WORKBENCH_LOADED__ = true;

  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  let stopFlag = false;
  let activeRunId = 0;

  function emit(type, payload = {}) {
    try {
      chrome.runtime.sendMessage({ type: `price-filler:${type}`, ...payload }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_error) {
      // The side panel may be closed.
    }
  }

  function log(text, level = "") {
    emit("log", { text, level });
  }

  function sendStatus(filled, total) {
    emit("status", { filled, total });
  }

  function sendDone(filled, total) {
    emit("done", { filled, total });
  }

  function sendError(text) {
    emit("error", { text });
  }

  function setReactInputValue(input, value) {
    input.focus();
    nativeInputValueSetter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function extractMaxDailyPrice(row) {
    const tds = row.querySelectorAll("td");
    for (const td of tds) {
      if (td.classList.contains("TB_checkCell_5-123-0") || td.classList.contains("TB_checkCell_5-120-1")) {
        continue;
      }

      if (td.querySelector('input[currency="CNY"]')) {
        continue;
      }

      const text = td.textContent || "";
      if (!text.includes("~")) {
        continue;
      }

      const priceMatches = text.match(/([\d,.]+)\s*元/g);
      if (!priceMatches?.length) {
        continue;
      }

      const prices = priceMatches
        .map((priceText) => Number(priceText.replace(/[,元]/g, "")))
        .filter((price) => Number.isFinite(price) && price > 0);

      if (prices.length) {
        return Math.max(...prices);
      }
    }

    return null;
  }

  function getTbody() {
    return (
      document.querySelector('tbody[data-testid="beast-core-table-middle-tbody"]') ||
      document.querySelector("div.TB_body_5-123-0 tbody") ||
      document.querySelector("div.TB_body_5-120-1 tbody")
    );
  }

  function getAllPriceInputs() {
    const tbody = getTbody();
    if (!tbody) return [];
    return Array.from(tbody.querySelectorAll('input[currency="CNY"][data-testid="beast-core-inputNumber-htmlInput"]'));
  }

  function fillOnce(coefficient) {
    const tbody = getTbody();
    if (!tbody) return { filled: 0, empty: 0, skipped: 0 };

    const rows = Array.from(tbody.querySelectorAll("tr"));
    let filled = 0;
    let empty = 0;
    let skipped = 0;

    rows.forEach((row, index) => {
      if (stopFlag) return;

      const input = row.querySelector('input[currency="CNY"][data-testid="beast-core-inputNumber-htmlInput"]');
      if (!input) return;

      if (input.value && input.value.trim() !== "") {
        skipped += 1;
        return;
      }

      const maxPrice = extractMaxDailyPrice(row);
      if (maxPrice !== null && maxPrice > 0) {
        const retailPrice = (maxPrice * coefficient).toFixed(2);
        setReactInputValue(input, retailPrice);
        filled += 1;
        log(`第 ${index + 1} 行：${maxPrice} 元 × ${coefficient} = ${retailPrice} 元`, "success");
      } else {
        empty += 1;
        log(`第 ${index + 1} 行：未找到有效日常价格`, "warn");
      }
    });

    return { filled, empty, skipped };
  }

  async function runFillLoop(coefficient, runId) {
    stopFlag = false;
    const maxRounds = 30;
    const interval = 600;

    for (let round = 1; round <= maxRounds; round += 1) {
      if (stopFlag || runId !== activeRunId) {
        log("已停止。", "warn");
        return;
      }

      log(`第 ${round} 轮`, "info");
      const result = fillOnce(coefficient);
      const allInputs = getAllPriceInputs();
      const total = allInputs.length;
      const filledInputs = allInputs.filter((input) => input.value && input.value.trim() !== "").length;
      const emptyInputs = total - filledInputs;

      sendStatus(filledInputs, total);

      if (total === 0) {
        sendError("未找到建议零售价输入框，请确认页面已加载。");
        return;
      }

      if (emptyInputs === 0) {
        sendDone(filledInputs, total);
        return;
      }

      log(`本轮填了 ${result.filled} 个，还剩 ${emptyInputs} 个，等待重试。`);
      await sleep(interval);
    }

    const allInputs = getAllPriceInputs();
    const total = allInputs.length;
    const filledInputs = allInputs.filter((input) => input.value && input.value.trim() !== "").length;
    log(`达到最大重试次数，仍有 ${total - filledInputs} 个未填写。`, "warn");
    sendDone(filledInputs, total);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.action === "price-filler:start") {
      activeRunId += 1;
      log(`系数：×${message.coefficient}`, "info");
      runFillLoop(Number(message.coefficient), activeRunId);
      return;
    }

    if (message?.action === "price-filler:stop") {
      stopFlag = true;
      activeRunId += 1;
    }
  });
})();
