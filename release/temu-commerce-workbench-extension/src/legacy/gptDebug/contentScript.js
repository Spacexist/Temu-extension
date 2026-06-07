(() => {
  const previous = globalThis.__temuGptDebugRuntime;
  if (previous?.listener) {
    try { chrome.runtime.onMessage.removeListener(previous.listener); } catch (_error) {}
  }

  const state = previous?.state || {
    busy: false,
    cancelled: false,
    baselineImageKeys: [],
    lastUserMessageCount: 0
  };
  state.busy = false;
  state.cancelled = false;

  const listener = (message, _sender, sendResponse) => {
    handleMessage(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse(serializeError(error, message)));
    return true;
  };

  chrome.runtime.onMessage.addListener(listener);
  globalThis.__temuGptDebugRuntime = { listener, state, loadedAt: Date.now() };

  async function handleMessage(message) {
    if (!message || message.type === "ping") return { ok: true, loadedAt: globalThis.__temuGptDebugRuntime.loadedAt };
    if (message.type === "debug:getState") return { ok: true, diagnostics: collectDiagnostics() };
    if (message.type === "debug:stop") { state.cancelled = true; clickStopButton(); return { ok: true, diagnostics: collectDiagnostics() }; }
    if (state.busy) return { ok: false, phase: "busy", error: "GPT 页面正在处理上一条调试指令", diagnostics: collectDiagnostics() };

    state.busy = true;
    state.cancelled = false;
    try {
      if (message.type === "debug:attach") return await attach(message);
      if (message.type === "debug:sendPrompt") return await sendPrompt(message);
      if (message.type === "debug:detectImage") return await detectImage(message);
      return { ok: false, phase: "unknown", error: `未知消息类型：${message.type}`, diagnostics: collectDiagnostics() };
    } finally {
      state.busy = false;
    }
  }

  async function attach(message) {
    const started = Date.now();
    if (!message.file?.dataUrl) throw makeError("attach", "缺少图片 dataUrl", { message });
    const composer = await waitForComposer(message.timeoutMs || 30000);
    composer.scrollIntoView({ block: "center", inline: "nearest" });
    composer.click();
    composer.focus();
    dismissToasts();

    const idle = await waitForIdle(45000);
    if (!idle.idle) throw makeError("attach", "ChatGPT 仍在生成或 Thinking，未上传图片", idle.diagnostics);

    const file = dataUrlToFile(message.file.dataUrl, message.file.name, message.file.type);
    const before = collectDiagnostics();
    state.baselineImageKeys = before.images.keys;
    const input = await findImageFileInput();
    injectFile(input, file);
    const confirmed = await waitForAttachment(before, message.timeoutMs || 45000);
    if (!confirmed.attached) throw makeError("attach", "附件未确认，已跳过发送提示词", confirmed);

    return {
      ok: true,
      phase: "attach",
      operationId: message.operationId || "",
      elapsedMs: Date.now() - started,
      diagnostics: confirmed
    };
  }

  async function sendPrompt(message) {
    const started = Date.now();
    const prompt = String(message.prompt || "").trim();
    if (!prompt) throw makeError("sendPrompt", "提示词为空", collectDiagnostics());
    const composer = await waitForComposer(message.timeoutMs || 30000);
    state.baselineImageKeys = collectImageKeys();
    state.lastUserMessageCount = getUserMessages().length;
    await focusAndSetText(composer, prompt);
    await waitForPromptApplied(composer, prompt);
    const sendButton = await waitForSendButton(message.timeoutMs || 30000);
    sendButton.click();
    await delay(300);
    return {
      ok: true,
      phase: "sendPrompt",
      operationId: message.operationId || "",
      elapsedMs: Date.now() - started,
      diagnostics: collectDiagnostics()
    };
  }

  async function detectImage(message) {
    const started = Date.now();
    const image = await waitForNewImage(message.timeoutMs || 420000);
    const imageDataUrl = await imageToDataUrl(image);
    return {
      ok: true,
      phase: "detectImage",
      operationId: message.operationId || "",
      elapsedMs: Date.now() - started,
      imageDataUrl,
      width: image.naturalWidth || 0,
      height: image.naturalHeight || 0,
      diagnostics: {
        imageKey: getImageKey(image),
        current: collectDiagnostics()
      }
    };
  }

  async function findImageFileInput() {
    const direct = findUsableFileInput();
    if (direct) return direct;
    const plus = document.querySelector("#composer-plus-btn, button[data-testid='composer-plus-btn']");
    if (plus && isVisible(plus)) { plus.click(); await delay(250); }
    const menuItem = findClickableByLabels(["上传照片", "上传图片", "添加照片", "添加图片", "upload photo", "upload image", "photos", "image"]);
    if (menuItem) { menuItem.click(); await delay(250); }
    const input = findUsableFileInput();
    if (!input) throw makeError("attach", "没有找到图片专用上传 input", collectDiagnostics());
    return input;
  }

  function findUsableFileInput() {
    const preferred = ["#upload-photos", "input[data-testid='upload-photos-input']", "input[id*='photo'][type='file']", "input[id*='image'][type='file']"];
    for (const selector of preferred) {
      const input = document.querySelector(selector);
      if (isImageInput(input)) return input;
    }
    return Array.from(document.querySelectorAll("input[type='file']")).find(isImageInput) || null;
  }

  function isImageInput(input) {
    if (!input || input.disabled) return false;
    const id = String(input.id || "").toLowerCase();
    const testId = String(input.getAttribute("data-testid") || "").toLowerCase();
    const accept = String(input.accept || "").toLowerCase();
    if (id === "upload-files" || testId.includes("upload-files")) return false;
    return accept.includes("image") || accept.includes(".png") || accept.includes(".jpg") || accept.includes(".jpeg") || accept.includes(".webp");
  }

  function injectFile(input, file) {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function waitForAttachment(before, timeoutMs) {
    const started = Date.now();
    let after = collectDiagnostics();
    while (Date.now() - started < timeoutMs) {
      throwIfCancelled();
      after = collectDiagnostics();
      const imageDelta = after.images.count - before.images.count;
      const attachmentDelta = after.attachments.count - before.attachments.count;
      const newKeys = after.images.keys.filter((key) => !before.images.keys.includes(key));
      if (imageDelta > 0 || attachmentDelta > 0 || newKeys.length > 0) {
        return { attached: true, before, after, imageDelta, attachmentDelta, newKeys };
      }
      await delay(300);
    }
    return { attached: false, reason: "attachment_timeout", before, after };
  }

  async function waitForNewImage(timeoutMs) {
    const started = Date.now();
    let found = null;
    let stableSince = 0;
    while (Date.now() - started < timeoutMs) {
      throwIfCancelled();
      const limitText = findLatestAssistantLimitText();
      if (limitText) {
        throw makeError("limit", "ChatGPT 图片生成额度已用尽，未生成新图，禁止下载原图。", {
          limitText,
          current: collectDiagnostics()
        });
      }
      const image = newestGeneratedImage();
      if (image) {
        if (getImageKey(image) === getImageKey(found)) stableSince = stableSince || Date.now();
        else { found = image; stableSince = Date.now(); }
      }
      if (found && Date.now() - stableSince > 900) return found;
      await delay(500);
    }
    if (found) return found;
    throw makeError("detectImage", "等待生成图片超时", collectDiagnostics());
  }

  function newestGeneratedImage() {
    const baseline = new Set(state.baselineImageKeys || []);
    const assistantNodes = getAssistantMessagesAfterLastPrompt();
    const imageRoot = assistantNodes.length ? assistantNodes[assistantNodes.length - 1] : null;
    const images = Array.from(imageRoot ? imageRoot.querySelectorAll("img") : []).filter(isVisible);
    for (let i = images.length - 1; i >= 0; i -= 1) {
      const img = images[i];
      const key = getImageKey(img);
      if (!key || baseline.has(key)) continue;
      if (!img.complete && img.naturalWidth === 0) continue;
      if ((img.naturalWidth || 0) < 128 || (img.naturalHeight || 0) < 128) continue;
      if (isLikelyIcon(img)) continue;
      return img;
    }
    return null;
  }

  function findLatestAssistantLimitText() {
    const messages = getAssistantMessagesAfterLastPrompt();
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = normalizeText(messages[i].innerText || messages[i].textContent || "");
      if (/hit the .*plan limit|limit resets|image generations requests|图片生成.*限制|额度|限额/i.test(text)) {
        return text;
      }
    }
    return "";
  }

  function getUserMessages() {
    return Array.from(document.querySelectorAll("[data-message-author-role='user']")).filter(isVisible);
  }

  function getAssistantMessagesAfterLastPrompt() {
    const roleNodes = Array.from(document.querySelectorAll("[data-message-author-role]")).filter(isVisible);
    const userNodes = roleNodes.filter((node) => node.getAttribute("data-message-author-role") === "user");
    const lastUser = userNodes[state.lastUserMessageCount] || userNodes[userNodes.length - 1] || null;
    if (!lastUser) return [];

    const messages = [];
    let afterLastUser = false;
    for (const node of roleNodes) {
      if (node === lastUser) {
        afterLastUser = true;
        continue;
      }
      if (afterLastUser && node.getAttribute("data-message-author-role") === "assistant") {
        messages.push(node);
      }
    }
    return messages;
  }

  async function waitForComposer(timeoutMs) {
    return await waitFor(() => {
      const selectors = ["#prompt-textarea[contenteditable='true']", ".ProseMirror[contenteditable='true']", "[contenteditable='true'][aria-label*='聊天']", "[contenteditable='true'][aria-label*='ChatGPT']"];
      for (const selector of selectors) {
        const node = Array.from(document.querySelectorAll(selector)).find(isVisible);
        if (node) return node;
      }
      return Array.from(document.querySelectorAll("textarea[name='prompt-textarea'], textarea#prompt-textarea, textarea")).find((node) => !node.disabled && isVisible(node));
    }, timeoutMs, "没有找到 GPT 输入框");
  }

  async function focusAndSetText(element, text) {
    element.scrollIntoView({ block: "center", inline: "nearest" });
    element.click();
    element.focus();
    if (element.matches("textarea")) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter ? setter.call(element, text) : element.value = text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("delete", false);
    const inserted = document.execCommand("insertText", false, text);
    if (!inserted) {
      element.innerHTML = `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
    await delay(50);
  }

  async function waitForPromptApplied(element, prompt) {
    const probe = String(prompt || "").trim().slice(0, 20);
    if (!probe) return;
    await waitFor(() => getText(element).includes(probe), 3000, "提示词没有写入输入框");
  }

  async function waitForSendButton(timeoutMs) {
    return await waitFor(() => {
      const selectors = ["button[data-testid='send-button']", "button[data-testid='composer-send-button']", "button[aria-label*='发送']", "button[aria-label*='Send']", "button.composer-submit-button-color"];
      const preferred = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
      const candidates = preferred.length ? preferred : Array.from(document.querySelectorAll("button"));
      return candidates.find((button) => {
        if (!isVisible(button) || button.disabled || button.getAttribute("aria-disabled") === "true") return false;
        const label = getNodeLabel(button).toLowerCase();
        if (label.includes("语音") || label.includes("voice")) return false;
        return label.includes("send") || label.includes("发送") || label.includes("submit") || label.includes("composer-send");
      });
    }, timeoutMs, "发送按钮不可用");
  }

  async function waitForIdle(timeoutMs) {
    const started = Date.now();
    let diagnostics = getGeneratingDiagnostics();
    while (Date.now() - started < timeoutMs) {
      throwIfCancelled();
      diagnostics = getGeneratingDiagnostics();
      if (!diagnostics.generating) return { idle: true, diagnostics };
      await delay(500);
    }
    return { idle: false, diagnostics };
  }

  function getGeneratingDiagnostics() {
    const selectors = ["button[data-testid*='stop']", "button[aria-label*='停止']", "button[aria-label*='Stop']", "[data-testid*='stop-streaming']", "[data-testid*='composer-stop']"];
    const node = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).find((item) => isVisible(item) && !item.disabled && item.getAttribute("aria-disabled") !== "true");
    if (node) return { generating: true, reason: "stop_button", label: getNodeLabel(node) };
    return { generating: false, reason: "none", label: "" };
  }

  function collectDiagnostics() {
    const images = Array.from(document.images).filter(isVisible);
    const attachmentNodes = ["[data-testid*='attachment']", "[data-testid*='file']", "[data-testid*='upload']", "[class*='attachment']", "[class*='file-preview']", "[class*='upload']"]
      .flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter(isVisible);
    return {
      url: location.href,
      title: document.title,
      composerFound: Boolean(document.querySelector("#prompt-textarea, .ProseMirror")),
      generating: getGeneratingDiagnostics(),
      fileInputs: Array.from(document.querySelectorAll("input[type='file']")).map((input) => ({ id: input.id || "", accept: input.accept || "", testId: input.getAttribute("data-testid") || "", disabled: Boolean(input.disabled), multiple: Boolean(input.multiple) })),
      images: { count: images.length, keys: images.map(getImageKey).filter(Boolean).slice(-12) },
      attachments: { count: new Set(attachmentNodes).size }
    };
  }

  function clickStopButton() {
    const buttons = Array.from(document.querySelectorAll("button"));
    const button = buttons.find((node) => isVisible(node) && !node.disabled && /stop|停止|中断/i.test(getNodeLabel(node)));
    if (button) button.click();
  }

  function dismissToasts() {
    Array.from(document.querySelectorAll("button, [role='button']")).forEach((button) => {
      const label = getNodeLabel(button).toLowerCase();
      if (isVisible(button) && (label === "×" || label.includes("close") || label.includes("关闭"))) button.click();
    });
  }

  function findClickableByLabels(labels) {
    return Array.from(document.querySelectorAll("button, [role='button'], [role='menuitem'], [data-testid]")).find((node) => {
      if (!isVisible(node) || node.disabled || node.getAttribute("aria-disabled") === "true") return false;
      const label = getNodeLabel(node).toLowerCase();
      return labels.some((item) => label.includes(item.toLowerCase()));
    }) || null;
  }

  async function imageToDataUrl(img) {
    const url = img.currentSrc || img.src || "";
    if (url.startsWith("data:")) return url;
    const response = await fetch(url);
    const blob = await response.blob();
    return await blobToDataUrl(blob);
  }

  function dataUrlToFile(dataUrl, name, type) {
    const [meta, body] = String(dataUrl).split(",");
    const mime = type || (meta.match(/data:([^;]+)/) || [])[1] || "image/png";
    const binary = atob(body || "");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], sanitizeUploadName(name, mime), { type: mime });
  }

  function sanitizeUploadName(name, mime) {
    const ext = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : mime.includes("gif") ? "gif" : "png";
    const raw = String(name || `temu_image.${ext}`);
    const dot = raw.lastIndexOf(".");
    const stem = (dot === -1 ? raw : raw.slice(0, dot)).replace(/[\\/:*?"<>|#%&{}$!'@+`=，。；、（）【】\[\]]+/g, "_").replace(/\s+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "temu_image";
    return `${stem}.${dot === -1 ? ext : raw.slice(dot + 1).replace(/[^a-z0-9]/gi, "").toLowerCase() || ext}`;
  }

  function blobToDataUrl(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = reject; reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); }); }
  function collectImageKeys() { return Array.from(document.images).map(getImageKey).filter(Boolean); }
  function getImageKey(img) { return img ? (img.currentSrc || img.src || img.getAttribute("src") || "") : ""; }
  function isLikelyIcon(img) { const rect = img.getBoundingClientRect(); return rect.width < 128 || rect.height < 128; }
  function getNodeLabel(node) { return normalizeText([node?.getAttribute?.("aria-label"), node?.getAttribute?.("data-testid"), node?.textContent].filter(Boolean).join(" ")); }
  function getText(node) { return normalizeText(node?.matches?.("textarea") ? node.value : node?.innerText || node?.textContent || ""); }
  function normalizeText(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
  function isVisible(node) { if (!node) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"; }
  function throwIfCancelled() { if (state.cancelled) throw makeError("stopped", "已停止", collectDiagnostics()); }
  function waitFor(fn, timeoutMs, errorMessage) { return new Promise((resolve, reject) => { const started = Date.now(); tick(); function tick() { try { const value = fn(); if (value) { resolve(value); return; } if (Date.now() - started >= timeoutMs) { reject(makeError("timeout", errorMessage, collectDiagnostics())); return; } setTimeout(tick, 250); } catch (error) { reject(error); } } }); }
  function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  function makeError(phase, error, diagnostics) { return { phase, error: String(error || "未知错误"), diagnostics }; }
  function serializeError(error, message) { return { ok: false, phase: error?.phase || "unknown", operationId: message?.operationId || "", sequenceNumber: message?.sequenceNumber || 0, error: String(error?.error || error?.message || error || "未知错误"), diagnostics: error?.diagnostics || collectDiagnostics() }; }
  function escapeHtml(value) { return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
})();
