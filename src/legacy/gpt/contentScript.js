(() => {
  const previousRuntime = globalThis.__temuGptAutomatorRuntime;
  if (previousRuntime?.listener) {
    try {
      chrome.runtime.onMessage.removeListener(previousRuntime.listener);
    } catch (_error) {
      // The previous listener may belong to an invalidated extension context.
    }
  }

  const state = previousRuntime?.state || {
    busy: false,
    cancelled: false,
    baselineImageKeys: new Set()
  };

  state.busy = false;
  state.cancelled = false;

  const listener = (message, sender, sendResponse) => {
    handleMessage(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse(serializeAutomationError(error, message)));
    return true;
  };

  chrome.runtime.onMessage.addListener(listener);
  globalThis.__temuGptAutomatorRuntime = {
    listener,
    state,
    loadedAt: Date.now()
  };

  async function handleMessage(message) {
    if (!message || message.type === "ping") {
      return { ok: true };
    }

    if (message.type === "gpt:stop" || message.type === "stopRun") {
      state.cancelled = true;
      clickStopButton();
      return { ok: true, operationId: message.operationId || "" };
    }

    if (state.busy) {
      return { ok: false, error: "页面正在处理上一张图片" };
    }

    state.busy = true;
    try {
      if (message.type === "gpt:plan" || message.type === "runPlan") {
        return await runPlan(message);
      }
      if (message.type === "gpt:execute" || message.type === "runExecute") {
        return await runExecute(message);
      }
      return { ok: false, error: `未知消息类型：${message.type}` };
    } finally {
      state.busy = false;
    }
  }

  async function runPlan(message) {
    state.cancelled = false;
    await waitForComposer(message.timeoutMs);
    state.baselineImageKeys = collectImageKeys();
    const attachResult = await attachImage(message.file, message);
    const assistantBaseline = getAssistantBaseline();
    await setPromptAndSend(message.prompt);
    const planText = await waitForAssistantText(message.timeoutMs || 240000, assistantBaseline);
    if (!planText || planText.length < 8) {
      throw createAutomationError("plan", "规划文本过短或为空", {
        sequenceNumber: message.sequenceNumber || 0,
        operationId: message.operationId || ""
      });
    }
    return {
      ok: true,
      operationId: message.operationId || "",
      phase: "plan",
      planText,
      diagnostics: {
        attach: attachResult.diagnostics
      }
    };
  }

  async function runExecute(message) {
    state.cancelled = false;
    await waitForComposer(message.timeoutMs);
    state.baselineImageKeys = collectImageKeys();
    await setPromptAndSend(message.prompt);
    const imageResult = await waitForNewImage(message.timeoutMs || 420000);
    if (!imageResult?.imageDataUrl) {
      throw createAutomationError("detecting_image", "没有检测到新生成图片", {
        sequenceNumber: message.sequenceNumber || 0,
        operationId: message.operationId || ""
      });
    }
    return {
      ok: true,
      operationId: message.operationId || "",
      phase: "execute",
      imageDataUrl: imageResult.imageDataUrl,
      width: imageResult.width,
      height: imageResult.height,
      diagnostics: imageResult.diagnostics
    };
  }

  async function attachImage(filePayload, message) {
    if (!filePayload || !filePayload.dataUrl) {
      throw createAutomationError("attach", "缺少图片数据", {
        sequenceNumber: message.sequenceNumber || 0,
        operationId: message.operationId || ""
      });
    }

    const file = dataUrlToFile(filePayload.dataUrl, filePayload.name, filePayload.type);
    const composer = await waitForComposer(message.timeoutMs);
    composer.scrollIntoView({ block: "center", inline: "nearest" });
    composer.click();
    composer.focus();
    dismissUploadToasts();

    const idleResult = await waitForChatgptIdle(30000);
    if (!idleResult.idle) {
      throw createAutomationError("attach", "ChatGPT 当前仍在生成或 Thinking，未上传图片。", {
        sequenceNumber: message.sequenceNumber || 0,
        operationId: message.operationId || "",
        fileName: filePayload.name || "",
        reason: "gpt_busy",
        generating: idleResult.diagnostics
      });
    }

    const baseline = collectAttachmentDiagnostics();
    await injectFileIntoComposer(file);

    let attached = await waitForAttachmentConfirmed(baseline, 3500);
    if (!attached.attached) {
      await injectFileIntoComposer(file);
      attached = await waitForAttachmentConfirmed(baseline, 8500);
    }

    if (!attached.attached) {
      throw createAutomationError("attach", "附件未确认，已跳过发送 prompt。", {
        sequenceNumber: message.sequenceNumber || 0,
        operationId: message.operationId || "",
        fileName: filePayload.name || "",
        before: baseline,
        after: attached.after,
        reason: attached.reason
      });
    }

    return attached;
  }

  async function injectFileIntoComposer(file) {
    const input = await findFileInput();
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function findFileInput() {
    await clickAttachButton();
    const input = findUsableFileInput();
    if (!input) {
      throw createAutomationError("attach", "没有找到 GPT 的图片上传入口，请确认页面已登录且输入框可用。", collectAttachmentDiagnostics());
    }
    return input;
  }

  async function clickAttachButton() {
    if (findUsableFileInput()) return;

    const explicitButton = document.querySelector("#composer-plus-btn, button[data-testid='composer-plus-btn']");
    if (explicitButton && isVisible(explicitButton)) {
      explicitButton.click();
      await delay(250);
      await clickUploadMenuItem();
      return;
    }

    const attachButton = findClickableByLabels([
      "添加文件",
      "添加照片",
      "attach",
      "upload"
    ]);
    if (attachButton) {
      attachButton.click();
      await delay(250);
      await clickUploadMenuItem();
    }
  }

  async function clickUploadMenuItem() {
    if (findUsableFileInput()) return;
    const uploadItem = findClickableByLabels([
      "上传照片",
      "上传图片",
      "添加照片",
      "添加图片",
      "upload photo",
      "upload image",
      "photos",
      "image"
    ]);
    if (uploadItem) {
      uploadItem.click();
      await delay(250);
    }
  }

  function findClickableByLabels(labels) {
    const nodes = Array.from(document.querySelectorAll("button, [role='button'], [role='menuitem'], [data-testid]"));
    return nodes.find((node) => {
      if (!isVisible(node) || node.disabled || node.getAttribute("aria-disabled") === "true") return false;
      const label = normalizeText([
        node.getAttribute("aria-label"),
        node.getAttribute("data-testid"),
        node.textContent
      ].filter(Boolean).join(" ")).toLowerCase();
      return labels.some((needle) => label.includes(needle.toLowerCase()));
    }) || null;
  }

  function dismissUploadToasts() {
    const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
    for (const button of buttons) {
      const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`.toLowerCase();
      if (isVisible(button) && (label === "×" || label.includes("close") || label.includes("关闭"))) {
        button.click();
      }
    }
  }

  function findUsableFileInput() {
    const inputs = Array.from(document.querySelectorAll("input[type='file']"));
    const preferredSelectors = [
      "#upload-photos",
      "input[data-testid='upload-photos-input']",
      "input[id*='photo'][type='file']",
      "input[id*='image'][type='file']"
    ];

    for (const selector of preferredSelectors) {
      const input = document.querySelector(selector);
      if (input && isImageFileInput(input)) return input;
    }

    const usable = inputs.filter(isImageFileInput);
    return usable[0] || null;
  }

  function isImageFileInput(input) {
    if (!input || input.disabled) return false;
    const id = String(input.id || "").toLowerCase();
    const testId = String(input.getAttribute("data-testid") || "").toLowerCase();
    const accept = String(input.accept || "").toLowerCase();
    if (id === "upload-files" || testId.includes("upload-files")) return false;
    return isImageFileInputAccept(accept);
  }

  function isImageFileInputAccept(accept) {
    if (!accept) return false;
    return accept.includes("image")
      || accept.includes(".png")
      || accept.includes(".jpg")
      || accept.includes(".jpeg")
      || accept.includes(".webp");
  }

  async function waitForAttachmentConfirmed(baseline, timeoutMs) {
    const started = Date.now();
    let after = collectAttachmentDiagnostics();

    while (Date.now() - started < timeoutMs) {
      throwIfCancelled();
      after = collectAttachmentDiagnostics();
      const newImageKeys = after.imageKeys.filter((key) => !baseline.imageKeys.includes(key));
      const attachmentDelta = after.attachmentCount - baseline.attachmentCount;
      const imageDelta = after.imageCount - baseline.imageCount;

      if (newImageKeys.length || attachmentDelta > 0 || imageDelta > 0) {
        return {
          attached: true,
          diagnostics: {
            before: baseline,
            after,
            newImageKeys: newImageKeys.slice(0, 5),
            attachmentDelta,
            imageDelta
          }
        };
      }

      await delay(350);
    }

    return {
      attached: false,
      reason: "attachment_timeout",
      after
    };
  }

  function collectAttachmentDiagnostics() {
    const images = Array.from(document.images).filter(isVisible);
    const attachmentSelectors = [
      "[data-testid*='attachment']",
      "[data-testid*='file']",
      "[data-testid*='upload']",
      "[aria-label*='附件']",
      "[aria-label*='上传']",
      "[aria-label*='Attach']",
      "[aria-label*='Upload']",
      "[class*='attachment']",
      "[class*='file-preview']",
      "[class*='upload']"
    ];
    const attachmentNodes = attachmentSelectors
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .filter(isVisible);

    return {
      imageCount: images.length,
      imageKeys: images.map(getImageKey).filter(Boolean),
      attachmentCount: new Set(attachmentNodes).size,
      fileInputs: collectFileInputDiagnostics()
    };
  }

  function collectFileInputDiagnostics() {
    return Array.from(document.querySelectorAll("input[type='file']")).map((input) => ({
      id: input.id || "",
      accept: input.accept || "",
      testId: input.getAttribute("data-testid") || "",
      disabled: Boolean(input.disabled),
      multiple: Boolean(input.multiple),
      hidden: input.matches("[hidden], .hidden, .sr-only") || input.closest(".hidden") !== null
    }));
  }

  async function setPromptAndSend(prompt) {
    const composer = await waitForComposer();
    await focusAndSetText(composer, prompt);
    await waitForPromptApplied(composer, prompt);
    const sendButton = await waitForSendButton();
    sendButton.click();
  }

  async function waitForComposer(timeoutMs = 30000) {
    return await waitFor(() => {
      const editableSelectors = [
        "#prompt-textarea[contenteditable='true']",
        ".ProseMirror[contenteditable='true']",
        "[contenteditable='true'][aria-label*='ChatGPT']",
        "[contenteditable='true'][aria-label*='聊天']"
      ];
      const editable = editableSelectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        .find(isVisible);
      if (editable) return editable;

      const textareaSelectors = [
        "textarea[name='prompt-textarea']",
        "textarea#prompt-textarea",
        "textarea"
      ];
      return textareaSelectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        .find((textarea) => !textarea.disabled && isVisible(textarea));
    }, timeoutMs, "没有找到 GPT 输入框");
  }

  async function focusAndSetText(element, text) {
    element.scrollIntoView({ block: "center", inline: "nearest" });
    element.click();
    element.focus();

    if (element.matches("textarea")) {
      setTextareaValue(element, text);
      return;
    }

    const cleanedText = String(text || "");
    clearEditable(element);
    const inserted = document.execCommand("insertText", false, cleanedText);

    if (!inserted || !getComposerText(element).includes(cleanedText.trim().slice(0, 20))) {
      element.innerHTML = textToComposerHtml(cleanedText);
      dispatchTextInput(element, cleanedText);
    }

    await delay(50);
  }

  function clearEditable(element) {
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("delete", false);
  }

  function setTextareaValue(textarea, text) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) {
      setter.call(textarea, text);
    } else {
      textarea.value = text;
    }
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function dispatchTextInput(element, text) {
    element.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: text
    }));
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text
    }));
  }

  function textToComposerHtml(text) {
    const paragraphs = String(text || "")
      .split(/\n/)
      .map((line) => line ? escapeHtml(line) : "<br>");
    return `<p>${paragraphs.join("<br>")}</p>`;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function waitForPromptApplied(element, prompt, timeoutMs = 3000) {
    const probe = String(prompt || "").trim().slice(0, 20);
    if (!probe) return;

    await waitFor(() => getComposerText(element).includes(probe), timeoutMs, "提示词没有写入 GPT 输入框");
  }

  function getComposerText(element) {
    return normalizeText(element?.matches?.("textarea") ? element.value : element?.innerText || element?.textContent || "");
  }

  async function waitForSendButton(timeoutMs = 30000) {
    return await waitFor(() => {
      const preferred = Array.from(document.querySelectorAll([
        "button[data-testid='send-button']",
        "button[data-testid='composer-send-button']",
        "button[aria-label*='发送']",
        "button[aria-label*='Send']",
        "button.composer-submit-button-color"
      ].join(",")));
      const candidates = preferred.length ? preferred : Array.from(document.querySelectorAll("button"));
      return candidates.find((button) => {
        if (!isVisible(button) || button.disabled || button.getAttribute("aria-disabled") === "true") return false;
        const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("data-testid") || ""} ${button.textContent || ""}`.toLowerCase();
        if (label.includes("语音") || label.includes("voice")) return false;
        return label.includes("send") || label.includes("发送") || label.includes("submit") || label.includes("composer-send");
      });
    }, timeoutMs, "发送按钮不可用");
  }

  async function waitForAssistantText(timeoutMs, baseline = getAssistantBaseline()) {
    const started = Date.now();
    let lastCandidateText = "";
    let stableSince = 0;

    while (Date.now() - started < timeoutMs) {
      throwIfCancelled();

      const messages = getAssistantMessages();
      const last = messages[messages.length - 1];
      const text = getLatestAssistantAfterLastUserText() || getAssistantText(last);
      const hasNewAssistant = messages.length > baseline.count;
      const hasChangedText = Boolean(text && text !== baseline.lastText);
      const isNewReply = Boolean(text) && (hasNewAssistant || hasChangedText || Boolean(getLatestAssistantAfterLastUserText()));

      if (isNewReply && text) {
        if (text !== lastCandidateText) {
          lastCandidateText = text;
          stableSince = Date.now();
        }

        const stableFor = Date.now() - stableSince;
        if (!isGenerating() && stableFor > 450) {
          return text;
        }

        if (stableFor > 1400) {
          return text;
        }
      }

      await delay(350);
    }

    throw new Error("等待 GPT 新回复超时");
  }

  async function waitForNewImage(timeoutMs) {
    const started = Date.now();
    let lastFound = null;
    let stableSince = 0;

    while (Date.now() - started < timeoutMs) {
      throwIfCancelled();
      const image = findNewestGeneratedImage();
      if (image) {
        if (getImageKey(image) === getImageKey(lastFound)) {
          stableSince = stableSince || Date.now();
        } else {
          lastFound = image;
          stableSince = Date.now();
        }
      }

      if (lastFound && Date.now() - stableSince > 900) {
        return await normalizeImageElement(lastFound);
      }

      await delay(500);
    }

    if (lastFound) {
      return await normalizeImageElement(lastFound);
    }
    throw createAutomationError("detecting_image", "等待生成图片超时", {
      baselineImageCount: state.baselineImageKeys.size,
      currentImageCount: Array.from(document.images).filter(isVisible).length
    });
  }

  async function waitUntilGeneratingStarts() {
    const started = Date.now();
    while (Date.now() - started < 12000) {
      throwIfCancelled();
      if (isGenerating()) return;
      await delay(300);
    }
  }

  async function waitForChatgptIdle(timeoutMs) {
    const started = Date.now();
    let diagnostics = getGeneratingDiagnostics();
    while (Date.now() - started < timeoutMs) {
      throwIfCancelled();
      diagnostics = getGeneratingDiagnostics();
      if (!diagnostics.generating) {
        return { idle: true, diagnostics };
      }
      await delay(500);
    }
    return { idle: false, diagnostics };
  }

  function isGenerating() {
    return getGeneratingDiagnostics().generating;
  }

  function getGeneratingDiagnostics() {
    const explicitStopSelectors = [
      "button[data-testid*='stop']",
      "button[aria-label*='停止']",
      "button[aria-label*='Stop']",
      "[data-testid*='stop-streaming']",
      "[data-testid*='composer-stop']"
    ];

    const explicitStopButton = explicitStopSelectors
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .find((node) => isVisible(node) && !node.disabled && node.getAttribute("aria-disabled") !== "true");
    if (explicitStopButton) {
      return {
        generating: true,
        reason: "explicit_stop_button",
        label: getNodeLabel(explicitStopButton)
      };
    }

    const buttons = Array.from(document.querySelectorAll("button"));
    const stopButton = buttons.find((button) => {
      if (!isVisible(button) || button.disabled || button.getAttribute("aria-disabled") === "true") return false;
      const label = getNodeLabel(button).toLowerCase();
      return label.includes("stop")
        || label.includes("停止")
        || label.includes("streaming")
        || label.includes("interrupt")
        || label.includes("中断");
    });
    return {
      generating: Boolean(stopButton),
      reason: stopButton ? "label_stop_button" : "none",
      label: stopButton ? getNodeLabel(stopButton) : ""
    };
  }

  function getNodeLabel(node) {
    return normalizeText([
      node?.getAttribute?.("aria-label"),
      node?.getAttribute?.("data-testid"),
      node?.textContent
    ].filter(Boolean).join(" "));
  }

  function clickStopButton() {
    const buttons = Array.from(document.querySelectorAll("button"));
    const stopButton = buttons.find((button) => {
      if (!isVisible(button) || button.disabled || button.getAttribute("aria-disabled") === "true") return false;
      const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("data-testid") || ""} ${button.textContent || ""}`.toLowerCase();
      return label.includes("stop") || label.includes("停止");
    });
    if (stopButton) {
      stopButton.click();
    }
  }

  function throwIfCancelled() {
    if (state.cancelled) {
      throw new Error("已停止");
    }
  }

  function getAssistantMessages() {
    const assistantNodes = Array.from(document.querySelectorAll("[data-message-author-role='assistant']")).filter(isVisible);
    if (assistantNodes.length) {
      return assistantNodes;
    }

    return Array.from(document.querySelectorAll("[data-testid*='conversation-turn']"))
      .filter((node) => isVisible(node) && !String(node.textContent || "").includes("You said:"));
  }

  function getAssistantBaseline() {
    const messages = getAssistantMessages();
    const last = messages[messages.length - 1];
    return {
      count: messages.length,
      lastText: getAssistantText(last)
    };
  }

  function getAssistantText(node) {
    return normalizeText(node ? node.innerText || node.textContent || "" : "");
  }

  function getLatestAssistantAfterLastUserText() {
    const roleNodes = Array.from(document.querySelectorAll("[data-message-author-role]")).filter(isVisible);
    let latest = "";

    for (const node of roleNodes) {
      const role = node.getAttribute("data-message-author-role");
      if (role === "user") {
        latest = "";
      } else if (role === "assistant") {
        latest = getAssistantText(node) || latest;
      }
    }

    return latest;
  }

  function collectImageKeys() {
    return new Set(Array.from(document.images).map(getImageKey).filter(Boolean));
  }

  function findNewestGeneratedImage() {
    const images = Array.from(document.images).filter(isVisible);
    for (let i = images.length - 1; i >= 0; i -= 1) {
      const img = images[i];
      const key = getImageKey(img);
      if (!key || state.baselineImageKeys.has(key)) continue;
      if (!img.complete && img.naturalWidth === 0) continue;
      if (img.naturalWidth < 128 || img.naturalHeight < 128) continue;
      if (isLikelyAvatarOrIcon(img)) continue;
      return img;
    }
    return null;
  }

  function getImageKey(img) {
    if (!img) return "";
    return img.currentSrc || img.src || img.getAttribute("src") || "";
  }

  function isLikelyAvatarOrIcon(img) {
    const src = String(img.currentSrc || img.src || "").toLowerCase();
    const alt = String(img.alt || "").toLowerCase();
    if (src.startsWith("data:image/svg")) return true;
    if (alt.includes("avatar") || alt.includes("user")) return true;
    const rect = img.getBoundingClientRect();
    return rect.width < 128 || rect.height < 128;
  }

  async function normalizeImageElement(img) {
    const imageDataUrl = await normalizeImageUrl(img.currentSrc || img.src || "");
    return {
      imageDataUrl,
      width: img.naturalWidth || 0,
      height: img.naturalHeight || 0,
      diagnostics: {
        srcKind: imageDataUrl.startsWith("data:") ? "data" : "url",
        originalSrcKind: String(img.currentSrc || img.src || "").startsWith("blob:") ? "blob" : "url",
        width: img.naturalWidth || 0,
        height: img.naturalHeight || 0
      }
    };
  }

  async function normalizeImageUrl(url) {
    if (!url) return "";
    if (url.startsWith("data:")) return url;
    if (url.startsWith("blob:")) {
      const response = await fetch(url);
      const blob = await response.blob();
      return await blobToDataUrl(blob);
    }
    return url;
  }

  function dataUrlToFile(dataUrl, name, type) {
    const parts = dataUrl.split(",");
    const header = parts[0] || "";
    const mime = type || (header.match(/data:([^;]+)/) || [])[1] || "image/png";
    const binary = atob(parts[1] || "");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new File([bytes], sanitizeUploadFileName(name, mime), { type: mime });
  }

  function sanitizeUploadFileName(name, mime) {
    const fallbackExt = extensionFromMime(mime) || "png";
    const rawName = String(name || `image.${fallbackExt}`);
    const dot = rawName.lastIndexOf(".");
    const ext = dot === -1 ? fallbackExt : rawName.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") || fallbackExt;
    const stem = (dot === -1 ? rawName : rawName.slice(0, dot))
      .replace(/[\\/:*?"<>|#%&{}$!'@+`=，。；、（）【】\[\]]+/g, "_")
      .replace(/\s+/g, "_")
      .replace(/[^\w.\-\u4e00-\u9fa5]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "temu_image";
    return `${stem}.${ext}`;
  }

  function extensionFromMime(mime) {
    const normalized = String(mime || "").toLowerCase();
    if (normalized.includes("jpeg")) return "jpg";
    if (normalized.includes("webp")) return "webp";
    if (normalized.includes("gif")) return "gif";
    return "png";
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("图片转换失败"));
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  }

  function normalizeText(text) {
    return String(text || "").replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function isVisible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  async function waitFor(predicate, timeoutMs, errorMessage) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const result = predicate();
      if (result) return result;
      await delay(250);
    }
    throw new Error(errorMessage || "等待超时");
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function createAutomationError(phase, error, diagnostics = null) {
    return {
      phase,
      error: String(error || "未知错误"),
      diagnostics
    };
  }

  function serializeAutomationError(error, message) {
    return {
      ok: false,
      operationId: message?.operationId || "",
      sequenceNumber: message?.sequenceNumber || 0,
      phase: error?.phase || "unknown",
      error: String(error?.error || error?.message || error || "未知错误"),
      diagnostics: error?.diagnostics || null
    };
  }

})();
