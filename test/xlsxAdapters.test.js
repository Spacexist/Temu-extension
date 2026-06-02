import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { importT2ProductsFromXlsx } from "../src/infrastructure/xlsx/t2XlsxImporter.js";
import { exportProductsToXlsxBuffer } from "../src/infrastructure/xlsx/productSheetExporter.js";
import { readRowsFromXlsxFile, writeRowsToXlsxBuffer, writeWorkbookSheetsToXlsxBuffer } from "../src/infrastructure/xlsx/xlsxSheetIO.js";

function rowWith(columns) {
  const row = [];
  for (const [oneBasedIndex, value] of Object.entries(columns)) {
    row[Number(oneBasedIndex) - 1] = value;
  }
  return row;
}

function tempPath(filename) {
  const dir = mkdtempSync(path.join(tmpdir(), "temu-workbench-"));
  return path.join(dir, filename);
}

test("imports T2 products from real xlsx files through the xlsx adapter", () => {
  const infoPath = tempPath("info.xlsx");
  const pricePath = tempPath("price.xlsx");
  writeFileSync(infoPath, writeRowsToXlsxBuffer([
    rowWith({ 1: "NAME", 10: "images", 56: "SKC" }),
    rowWith({ 1: "Lamp", 10: "https://img.example/lamp.png", 56: "1001.0" }),
    rowWith({ 1: "No Price", 10: "https://img.example/missing.png", 56: "3003" })
  ]));
  writeFileSync(pricePath, writeRowsToXlsxBuffer([
    rowWith({ 1: "SKC", 7: "quoted price" }),
    rowWith({ 1: "1001", 7: "$12.50" }),
    rowWith({ 1: "1001", 7: "15.00" })
  ]));

  const result = importT2ProductsFromXlsx({ infoPath, pricePath });

  assert.equal(result.summary.matchedProductCount, 1);
  assert.equal(result.products[0].name, "Lamp");
  assert.equal(result.products[0].skc, "1001");
  assert.equal(result.products[0].quotedPrice, 15);
  assert.equal(result.summary.duplicatePriceSkcCount, 1);
});

test("exports products to a real xlsx workbook buffer", () => {
  const outputPath = tempPath("products.xlsx");
  const buffer = exportProductsToXlsxBuffer([
    {
      name: "Lamp",
      skc: "1001",
      imageUrl: "https://img.example/lamp.png",
      quotedPrice: 120,
      status: "priced",
      source1688: {
        url: "https://detail.1688.com/offer/1.html",
        goodsPrice: 35,
        shippingFee: 8,
        unitPrice: 43,
        weight: 0.5
      },
      pricing: {
        quantity: 2,
        discountRate: 1,
        profit: 62.5,
        actualProfit: 48.4,
        roi: 0.386996904,
        margin: 0.260416667
      }
    }
  ]);

  writeFileSync(outputPath, buffer);
  const rows = readRowsFromXlsxFile(outputPath, { sheetName: "Products" });

  assert.deepEqual(rows[0].slice(0, 5), ["NAME", "SKC", "imageUrl", "quotedPrice", "1688Url"]);
  assert.deepEqual(rows[1].slice(0, 10), [
    "Lamp",
    "1001",
    "https://img.example/lamp.png",
    120,
    "https://detail.1688.com/offer/1.html",
    35,
    8,
    43,
    0.5,
    2
  ]);
  assert.ok(readFileSync(outputPath).length > 1000);
});

test("writes multiple sheets to a real xlsx workbook buffer", () => {
  const outputPath = tempPath("multi-sheet.xlsx");
  const buffer = writeWorkbookSheetsToXlsxBuffer([
    {
      sheetName: "Result",
      rows: [["SKC", "quotedPrice"], ["1001", 15]]
    },
    {
      sheetName: "Duplicate SKC",
      rows: [["SKC", "rowNumber"], ["1001", 2], ["1001", 3]]
    }
  ]);

  writeFileSync(outputPath, buffer);

  assert.deepEqual(readRowsFromXlsxFile(outputPath, { sheetName: "Result" }), [
    ["SKC", "quotedPrice"],
    ["1001", 15]
  ]);
  assert.deepEqual(readRowsFromXlsxFile(outputPath, { sheetName: "Duplicate SKC" }), [
    ["SKC", "rowNumber"],
    ["1001", 2],
    ["1001", 3]
  ]);
});
