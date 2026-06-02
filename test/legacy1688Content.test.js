import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

function createVisibleElement(text = "") {
  return {
    textContent: text,
    value: "",
    querySelectorAll() {
      return [];
    }
  };
}

function createTableRow(cells) {
  return {
    querySelectorAll() {
      return cells;
    }
  };
}

function loadLegacyContentScript({ scripts = [], bodyText = "", queryMap = {} } = {}) {
  const scriptPath = path.resolve("src/legacy/1688/content.js");
  const script = readFileSync(scriptPath, "utf8");
  let listener = null;

  const context = {
    globalThis: {},
    window: {
      location: {
        href: "https://detail.1688.com/offer/123.html"
      },
      getComputedStyle() {
        return {
          display: "block",
          visibility: "visible"
        };
      }
    },
    document: {
      scripts,
      body: {
        innerText: bodyText
      },
      querySelectorAll(selector) {
        return queryMap[selector] || [];
      }
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener(callback) {
            listener = callback;
          }
        }
      }
    }
  };

  vm.runInNewContext(script, context);

  return () => {
    let response = null;
    listener({ type: "extract-product-data" }, null, (data) => {
      response = data;
    });
    return response;
  };
}

test("legacy 1688 content script falls back to the first labeled visible weight", () => {
  const extract = loadLegacyContentScript({
    bodyText: "商品参数 商品件重 500g 包装"
  });

  const response = extract();
  assert.equal(response.weight, "0.5");
});

test("legacy 1688 content script defaults to the first table weight when multiple rows exist", () => {
  const headerCells = [
    createVisibleElement("Color classification"),
    createVisibleElement("长度(cm)"),
    createVisibleElement("宽(cm)"),
    createVisibleElement("高度(cm)"),
    createVisibleElement("体积(cm³)"),
    createVisibleElement("重量(g)")
  ];
  const firstValueCells = [
    createVisibleElement("dark brown"),
    createVisibleElement("60"),
    createVisibleElement("15"),
    createVisibleElement("5"),
    createVisibleElement("4500"),
    createVisibleElement("100")
  ];
  const secondValueCells = [
    createVisibleElement("gray-pink"),
    createVisibleElement("60"),
    createVisibleElement("15"),
    createVisibleElement("5"),
    createVisibleElement("4500"),
    createVisibleElement("120")
  ];
  const root = {
    querySelectorAll(selector) {
      if (selector === "tr") {
        return [
          createTableRow(headerCells),
          createTableRow(firstValueCells),
          createTableRow(secondValueCells)
        ];
      }
      return [];
    }
  };

  const extract = loadLegacyContentScript({
    queryMap: {
      "#productPackInfo": [root]
    }
  });

  const response = extract();
  assert.equal(response.weight, "0.1");
});
