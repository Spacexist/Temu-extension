import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeJsonRecordsBySkc,
  productsToT2JsonRecords
} from "../src/application/usecases/appendT2ProductsToJson.js";

test("builds T2 JSON records from imported products", () => {
  const records = productsToT2JsonRecords([
    {
      id: "t2-1001",
      name: "Lamp",
      skc: "1001",
      quotedPrice: 99.99,
      imageUrl: "https://img.example/lamp.png",
      status: "imported"
    }
  ], new Date("2026-05-30T00:00:00.000Z"));

  assert.deepEqual(records, [
    {
      id: "t2-1001",
      name: "Lamp",
      skc: "1001",
      quotedPrice: 99.99,
      quoted_price: "99.99",
      imageUrl: "https://img.example/lamp.png",
      image_url: "https://img.example/lamp.png",
      status: "imported",
      source: "t2-intersection",
      savedAt: "2026-05-30T00:00:00.000Z"
    }
  ]);
});

test("appends new JSON records and updates existing SKCs", () => {
  const result = mergeJsonRecordsBySkc([
    { skc: "1001", name: "Old Lamp", unitPrice: 12 },
    { skc: "2002", name: "Shelf" }
  ], [
    {
      skc: "1001",
      name: "Lamp",
      quotedPrice: 99.99,
      savedAt: "2026-05-30T00:00:00.000Z"
    },
    {
      skc: "3003",
      name: "Chair",
      quotedPrice: 20,
      savedAt: "2026-05-30T00:00:00.000Z"
    }
  ]);

  assert.equal(result.addedCount, 1);
  assert.equal(result.updatedCount, 1);
  assert.deepEqual(result.records, [
    { skc: "2002", name: "Shelf" },
    {
      skc: "1001",
      name: "Lamp",
      unitPrice: 12,
      quotedPrice: 99.99,
      savedAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:00:00.000Z"
    },
    {
      skc: "3003",
      name: "Chair",
      quotedPrice: 20,
      savedAt: "2026-05-30T00:00:00.000Z"
    }
  ]);
});
