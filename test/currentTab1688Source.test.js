import assert from "node:assert/strict";
import test from "node:test";

test("currentTab1688Source reinjects the active extractor when the first response is empty", async () => {
  const sendMessages = [];
  const executeScripts = [];
  let sendCallCount = 0;

  globalThis.chrome = {
    tabs: {
      async query() {
        return [{ id: 321, url: "https://detail.1688.com/offer/1031569019669.html" }];
      },
      async sendMessage(tabId, message) {
        sendMessages.push({ tabId, message });
        sendCallCount += 1;

        if (sendCallCount === 1) {
          return undefined;
        }

        return {
          url: "https://detail.1688.com/offer/1031569019669.html",
          goodsPrice: 25,
          shippingFee: 8,
          unitPrice: 33,
          weight: 0.07
        };
      }
    },
    scripting: {
      async executeScript(config) {
        executeScripts.push(config);
      }
    }
  };

  const { createCurrentTab1688Source } = await import("../src/infrastructure/chrome/currentTab1688Source.js");
  const source = createCurrentTab1688Source();
  const extracted = await source.extractCurrentPage();

  assert.equal(extracted.weight, 0.07);
  assert.equal(sendMessages.length, 2);
  assert.deepEqual(executeScripts, [
    {
      target: { tabId: 321 },
      files: ["src/infrastructure/content/1688Content.js"]
    }
  ]);
});
