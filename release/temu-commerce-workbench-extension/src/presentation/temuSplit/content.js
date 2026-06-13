(function () {
  "use strict";

  if (window.top !== window || window.__temuSplitCollectorInstalled || isForbiddenSellerCenterUrl(window.location.href)) return;
  window.__temuSplitCollectorInstalled = true;

  const MESSAGE_SOURCE = "temu-split-collector";
  let enabled = true;
  let toastTimer = null;
  let lastExpectedAt = 0;
  let extensionContextValid = true;

  function teardownInvalidContext() {
    extensionContextValid = false;
    enabled = false;
    clearTimeout(toastTimer);

    window.removeEventListener("pointerdown", expectNaturalDetailTab, true);
    window.removeEventListener("mousedown", expectNaturalDetailTab, true);
    window.removeEventListener("message", handlePageMessage);
    window.removeEventListener("click", handleClick, true);
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      if (!extensionContextValid || !globalThis.chrome?.runtime?.id) {
        teardownInvalidContext();
        resolve({ ok: false, error: "Extension context expired. Refresh the Temu page." });
        return;
      }

      try {
        chrome.runtime.sendMessage(message, (response) => {
          const lastError = chrome.runtime?.lastError;
          if (lastError) {
            const error = lastError.message || "";
            if (/context invalidated|Extension context invalidated/i.test(error)) {
              teardownInvalidContext();
            }
            resolve({ ok: false, error });
            return;
          }
          resolve(response || { ok: false, error: "Extension did not respond." });
        });
      } catch (error) {
        if (/context invalidated|Extension context invalidated/i.test(String(error?.message || error))) {
          teardownInvalidContext();
        }
        resolve({ ok: false, error: error?.message || String(error) });
      }
    });
  }

  function asElement(target) {
    if (!target) return null;
    return target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
  }

  function isTemuUrl(url) {
    try {
      const { hostname } = new URL(url, window.location.href);
      return hostname === "temu.com" || hostname.endsWith(".temu.com");
    } catch {
      return false;
    }
  }

  function isForbiddenSellerCenterUrl(url) {
    try {
      const parsed = new URL(url, window.location.href);
      const hostname = parsed.hostname.toLowerCase();
      return hostname === "ads.temu.com"
        || hostname === "seller.kuajingmaihuo.com"
        || (hostname.endsWith(".temu.com") && hostname.includes("seller"));
    } catch {
      return false;
    }
  }

  function isProductDetailUrl(url) {
    try {
      const parsed = new URL(url, window.location.href);
      if (!isTemuUrl(parsed.href)) return false;

      const path = parsed.pathname.toLowerCase();
      const params = parsed.searchParams;

      return (
        path.includes("/product/") ||
        path.includes("/item/") ||
        path.includes("/goods/") ||
        path.endsWith("/goods.html") ||
        /-g-\d+\.html$/i.test(path) ||
        params.has("goods_id") ||
        params.has("product_id") ||
        params.has("item_id")
      );
    } catch {
      return false;
    }
  }

  function isProbablyListPage() {
    return isTemuUrl(window.location.href) && !isProductDetailUrl(window.location.href);
  }

  function isPlainLeftClick(event) {
    return (
      event.button === 0 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey
    );
  }

  function isIgnoredControl(target) {
    const element = asElement(target);
    return Boolean(
      element?.closest?.(
        'button, input, select, textarea, [aria-label*="cart" i], [data-cart], [data-add-cart]'
      )
    );
  }

  function getDirectDetailUrl(target) {
    const element = asElement(target);
    const link = element?.closest?.("a[href]");
    if (!link?.href) return null;
    return isProductDetailUrl(link.href) ? link.href : null;
  }

  function hasProductCardMarker(target) {
    const element = asElement(target);
    if (!element) return false;

    let current = element;
    let depth = 0;

    while (current && current !== document.documentElement && depth < 8) {
      for (const attr of Array.from(current.attributes || [])) {
        if (/(?:goodContainer|GoodsImage)[^\d]*(\d{8,})/i.test(attr.value)) {
          return true;
        }

        if (/^(data-)?(goods|product|item)-?id$/i.test(attr.name) && /^\d{8,}$/.test(attr.value)) {
          return true;
        }
      }

      if (
        current.querySelector?.(
          '[data-tooltip^="goodContainer-"], [data-tooltip*="GoodsImage-"], [data-goods-id], [data-product-id], [data-item-id]'
        )
      ) {
        return true;
      }

      current = current.parentElement;
      depth += 1;
    }

    return false;
  }

  function ensureToast() {
    let toast = document.getElementById("temu-split-collector-toast");
    if (toast) return toast;

    toast = document.createElement("div");
    toast.id = "temu-split-collector-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.documentElement.appendChild(toast);
    return toast;
  }

  function showToast(text, variant = "success") {
    if (!document.documentElement) return;

    const toast = ensureToast();
    toast.textContent = text;
    toast.dataset.variant = variant;
    toast.classList.add("is-visible");

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove("is-visible");
    }, variant === "onboarding" ? 9000 : 2600);
  }

  function shouldHandleEvent(event) {
    if (isForbiddenSellerCenterUrl(window.location.href)) return false;
    return enabled && isProbablyListPage() && isPlainLeftClick(event) && !isIgnoredControl(event.target);
  }

  function armPageDetailCapture() {
    window.postMessage({
      source: MESSAGE_SOURCE,
      type: "ARM_DETAIL_CAPTURE",
      ttlMs: 3500
    }, "*");
  }

  function expectNaturalDetailTab(event) {
    if (!shouldHandleEvent(event)) return;
    if (getDirectDetailUrl(event.target) || !hasProductCardMarker(event.target)) return;

    const now = Date.now();
    if (now - lastExpectedAt < 350) return;
    lastExpectedAt = now;

    armPageDetailCapture();

    sendMessage({ type: "TEMU_SPLIT_EXPECT_NATURAL_DETAIL_TAB" }).then((response) => {
      if (!response.ok && extensionContextValid) {
        showToast(response.error || "Extension messaging failed.", "error");
      }
    });
  }

  async function handlePageMessage(event) {
    if (event.source !== window || event.data?.source !== MESSAGE_SOURCE) return;
    if (event.data.type !== "CAPTURED_DETAIL_URL" || !isProductDetailUrl(event.data.url)) return;

    const response = await sendMessage({
      type: "TEMU_SPLIT_OPEN_DETAIL_IN_RIGHT_TAB",
      url: event.data.url
    });

    if (!response.ok && extensionContextValid) {
      showToast(response.error || "Could not open detail tab.", "error");
    }
  }

  async function handleClick(event) {
    if (!shouldHandleEvent(event)) return;

    const directUrl = getDirectDetailUrl(event.target);
    if (!directUrl) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const response = await sendMessage({
      type: "TEMU_SPLIT_OPEN_DETAIL_IN_RIGHT_TAB",
      url: directUrl
    });

    if (!response.ok) {
      showToast(response.error || "Could not open detail tab.", "error");
    }
  }

  async function handleShortcut(event) {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.code !== "KeyW") {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    const nextEnabled = !enabled;
    const response = await sendMessage({
      type: "TEMU_SPLIT_SET_ENABLED",
      enabled: nextEnabled
    });

    if (response.ok) {
      enabled = Boolean(response.status?.enabled ?? nextEnabled);
    } else if (extensionContextValid) {
      showToast(response.error || "快捷键切换失败。", "error");
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "STATUS_CHANGED") {
      enabled = Boolean(message.enabled);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "SHOW_TOAST") {
      showToast(message.text || "", message.variant || "success");
      sendResponse({ ok: true });
    }
  });

  sendMessage({ type: "TEMU_SPLIT_GET_STATUS" }).then((response) => {
    if (response.ok) {
      enabled = Boolean(response.status.enabled);
    }
  });

  window.addEventListener("pointerdown", expectNaturalDetailTab, true);
  window.addEventListener("mousedown", expectNaturalDetailTab, true);
  window.addEventListener("message", handlePageMessage);
  window.addEventListener("click", handleClick, true);
  window.addEventListener("keydown", handleShortcut, true);
})();
