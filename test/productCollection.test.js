import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeProductsIntoCollection,
  removeProductsFromCollection,
  selectProductsFromCollection
} from "../src/application/usecases/productCollection.js";

test("merges products into the collection by id or SKC", () => {
  const result = mergeProductsIntoCollection([
    { id: "t2-1001", skc: "1001", name: "Old Lamp" }
  ], [
    { id: "t2-1001", skc: "1001", name: "Lamp" },
    { skc: "2002", name: "Shelf" }
  ]);

  assert.equal(result.addedCount, 1);
  assert.equal(result.updatedCount, 1);
  assert.deepEqual(result.products, [
    { id: "t2-1001", skc: "1001", name: "Lamp" },
    { skc: "2002", name: "Shelf" }
  ]);
});

test("selects and removes products from the collection by id", () => {
  const products = [
    { id: "t2-1001", skc: "1001", name: "Lamp" },
    { skc: "2002", name: "Shelf" }
  ];

  assert.deepEqual(selectProductsFromCollection(products, ["2002"]), [
    { skc: "2002", name: "Shelf" }
  ]);
  assert.deepEqual(removeProductsFromCollection(products, ["t2-1001"]), [
    { skc: "2002", name: "Shelf" }
  ]);
});
