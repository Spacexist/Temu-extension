import assert from "node:assert/strict";
import test from "node:test";
import { calculatePricing } from "../src/domain/pricing.js";

test("calculates pricing with the legacy 1688 calculator formula", () => {
  const result = calculatePricing({
    quotedPrice: 120,
    unitPrice: 35,
    weight: 0.5,
    quantity: 2,
    discountRate: 1
  });

  assert.equal(result.actualPrice, 240);
  assert.equal(result.firstLegFee, 87.5);
  assert.equal(result.firstLegCost, 157.5);
  assert.equal(result.lastLegCost, 4);
  assert.equal(result.profit, 78.5);
  assert.equal(result.cargoLoss, 203.5);
  assert.equal(result.actualProfit, 64.4);
  assert.equal(Number(result.roi.toFixed(6)), 0.486068);
  assert.equal(Number(result.margin.toFixed(6)), 0.327083);
});

test("rejects non-positive prices before calculating", () => {
  assert.throws(
    () => calculatePricing({ quotedPrice: 0, unitPrice: 35, weight: 0.5 }),
    /quotedPrice must be a positive number/
  );
});
