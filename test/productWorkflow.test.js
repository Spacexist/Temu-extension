import assert from "node:assert/strict";
import test from "node:test";
import { calculateProductPricing } from "../src/application/usecases/calculateProductPricing.js";
import { enrichProductFrom1688 } from "../src/application/usecases/enrichProductFrom1688.js";
import { exportProducts } from "../src/application/usecases/exportProducts.js";
import { createImportedProduct } from "../src/domain/product.js";
import { createMemoryProductRepository } from "../src/infrastructure/storage/memoryProductRepository.js";

test("enriches a queued product from a 1688 adapter without coupling to DOM code", async () => {
  const product = createImportedProduct({
    id: "p-1",
    name: "Lamp",
    skc: "1001",
    quotedPrice: 120,
    imageUrl: "https://img.example/lamp.png"
  });
  const productRepository = createMemoryProductRepository([product]);
  const productSource1688 = {
    async extractCurrentPage() {
      return {
        url: "https://detail.1688.com/offer/1.html",
        goodsPrice: "35",
        shippingFee: "8",
        weight: "0.5"
      };
    }
  };

  const enriched = await enrichProductFrom1688({
    productId: "p-1",
    productRepository,
    productSource1688
  });

  assert.equal(enriched.status, "enriched_1688");
  assert.deepEqual(enriched.source1688, {
    url: "https://detail.1688.com/offer/1.html",
    goodsPrice: 35,
    shippingFee: 8,
    unitPrice: 43,
    weight: 0.5
  });
});

test("calculates pricing from queued product data and preserves the product queue record", async () => {
  const product = {
    ...createImportedProduct({
      id: "p-1",
      name: "Lamp",
      skc: "1001",
      quotedPrice: 120,
      imageUrl: "https://img.example/lamp.png"
    }),
    status: "enriched_1688",
    source1688: {
      unitPrice: 43,
      weight: 0.5
    }
  };
  const productRepository = createMemoryProductRepository([product]);

  const priced = await calculateProductPricing({
    productId: "p-1",
    productRepository,
    quantity: 2,
    discountRate: 1
  });

  assert.equal(priced.status, "priced");
  assert.equal(priced.pricing.profit, 62.5);
  assert.equal(priced.pricing.actualProfit, 48.4);
  assert.equal((await productRepository.get("p-1")).status, "priced");
});

test("exports non-failed products through a sheet exporter port", async () => {
  const completed = {
    ...createImportedProduct({
      id: "p-1",
      name: "Lamp",
      skc: "1001",
      quotedPrice: 120
    }),
    status: "priced"
  };
  const failed = {
    ...createImportedProduct({
      id: "p-2",
      name: "Shelf",
      skc: "2002",
      quotedPrice: 99
    }),
    status: "failed"
  };
  const productRepository = createMemoryProductRepository([completed, failed]);
  const exportedNames = [];
  const sheetExporter = {
    async export(products) {
      exportedNames.push(...products.map((product) => product.name));
      return { kind: "fake-workbook", count: products.length };
    }
  };

  const result = await exportProducts({ productRepository, sheetExporter });

  assert.deepEqual(result, { kind: "fake-workbook", count: 1 });
  assert.deepEqual(exportedNames, ["Lamp"]);
});
