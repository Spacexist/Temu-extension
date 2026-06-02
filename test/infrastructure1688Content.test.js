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

function loadActiveContentScript({ scripts = [], bodyText = "", queryMap = {} } = {}) {
  const scriptPath = path.resolve("src/infrastructure/content/1688Content.js");
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
    listener({ type: "extract-1688-product-data" }, null, (data) => {
      response = data;
    });
    return response;
  };
}

test("active 1688 content script extracts 45g from pieceWeightScale when unitWeight is zero", () => {
  const extract = loadActiveContentScript({
    scripts: [
      {
        textContent: `
          window.context={
            "unitWeight":0,
            "productPackInfo":{
              "fields":{
                "pieceWeightScale":{
                  "pieceWeightScaleInfo":[{"color":"green","weight":45}],
                  "columnList":[{"label":"颜色"},{"label":"重量(g)"}]
                }
              }
            }
          };
        `
      }
    ]
  });

  const response = extract();
  assert.equal(response.weight, 0.045);
});

test("active 1688 content script falls back to the weight column in the packaging table", () => {
  const headerCells = [createVisibleElement("颜色"), createVisibleElement("重量(g)")];
  const valueCells = [createVisibleElement("绿色"), createVisibleElement("45")];
  const root = {
    querySelectorAll(selector) {
      if (selector === "tr") {
        return [createTableRow(headerCells), createTableRow(valueCells)];
      }
      return [];
    }
  };

  const extract = loadActiveContentScript({
    queryMap: {
      "#productPackInfo": [root]
    }
  });

  const response = extract();
  assert.equal(response.weight, 0.045);
});

test("active 1688 content script does not guess a page-wide weight without a weight label", () => {
  const extract = loadActiveContentScript({
    scripts: [
      {
        textContent: `
          window.context={
            "productPackInfo":{"fields":{"unitWeight":0,"label":"商品件重尺"}},
            "shippingServices":{"fields":{"minWeight":0,"freightInfo":{"skuWeight":{}}}}
          };
        `
      }
    ],
    bodyText: "承诺3天发货 常发中通快递 首重 1kg 运费 5元"
  });

  const response = extract();
  assert.equal(response.weight, "");
});

test("active 1688 content script defaults to the first value when a weight header lists multiple weights", () => {
  const extract = loadActiveContentScript({
    bodyText: "商品件重尺 颜色 重量(g) 杏色 70 白色 80 黑色 90"
  });

  const response = extract();
  assert.equal(response.weight, 0.07);
});
