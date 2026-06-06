(function () {
  "use strict";

  if (window.__temuSplitCollectorPageHookInstalled) return;
  window.__temuSplitCollectorPageHookInstalled = true;

  const SOURCE = "temu-split-collector";
  let armedUntil = 0;
  let lastCapturedUrl = "";
  let lastCapturedAt = 0;

  function isTemuUrl(url) {
    try {
      const { hostname } = new URL(url, window.location.href);
      return hostname === "temu.com" || hostname.endsWith(".temu.com");
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

  function normalizeUrl(url) {
    try {
      return new URL(url, window.location.href).href;
    } catch {
      return String(url || "");
    }
  }

  function isBlankLikeUrl(url) {
    const value = String(url || "").trim().toLowerCase();
    return !value || value === "about:blank";
  }

  function captureDetailUrl(url) {
    if (!url || !isProductDetailUrl(url)) return false;

    const normalized = normalizeUrl(url);
    const now = Date.now();
    if (normalized === lastCapturedUrl && now - lastCapturedAt < 500) {
      return true;
    }

    lastCapturedUrl = normalized;
    lastCapturedAt = now;

    window.postMessage({
      source: SOURCE,
      type: "CAPTURED_DETAIL_URL",
      url: normalized
    }, "*");

    return true;
  }

  function createCapturedWindowProxy() {
    const fakeLocation = {};
    const fakeWindow = {
      closed: false,
      close() {
        this.closed = true;
      },
      focus() {},
      blur() {},
      postMessage() {}
    };

    const locationProxy = new Proxy(fakeLocation, {
      get(target, prop) {
        if (prop === "href") return target.href || "about:blank";
        if (prop === "assign" || prop === "replace") {
          return (url) => {
            captureDetailUrl(url);
          };
        }
        return target[prop];
      },
      set(target, prop, value) {
        if (prop === "href") {
          captureDetailUrl(value);
        }
        target[prop] = value;
        return true;
      }
    });

    return new Proxy(fakeWindow, {
      get(target, prop) {
        if (prop === "location") return locationProxy;
        if (prop in target) return target[prop];
        return undefined;
      },
      set(target, prop, value) {
        if (prop === "location") {
          captureDetailUrl(value);
          return true;
        }
        target[prop] = value;
        return true;
      }
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== SOURCE) return;
    if (event.data.type !== "ARM_DETAIL_CAPTURE") return;

    const ttl = Number(event.data.ttlMs) || 2500;
    armedUntil = Date.now() + Math.max(300, Math.min(ttl, 5000));
  });

  const originalOpen = window.open;
  window.open = function patchedOpen(url, target, features) {
    if (Date.now() <= armedUntil) {
      if (captureDetailUrl(url)) {
        return createCapturedWindowProxy();
      }

      if (isBlankLikeUrl(url)) {
        return createCapturedWindowProxy();
      }
    }

    return originalOpen.apply(window, arguments);
  };
})();
