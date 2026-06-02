import assert from "node:assert/strict";
import test from "node:test";

import {
  formatQuantityBoundValue,
  parseQuantityBoundNumber
} from "../src/legacy/1688/quantity_binding.js";

test("parses optional quantity-bound numbers", () => {
  assert.equal(parseQuantityBoundNumber("12.5"), 12.5);
  assert.equal(parseQuantityBoundNumber(""), null);
  assert.equal(parseQuantityBoundNumber("abc"), null);
});

test("formats values multiplied by quantity", () => {
  assert.equal(formatQuantityBoundValue(12.5, 3, 2), "37.50");
  assert.equal(formatQuantityBoundValue(0.045, 3, 3), "0.135");
});
