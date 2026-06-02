import assert from "node:assert/strict";
import test from "node:test";
import {
  detectTemplateColumns,
  findHeaderRowIndex,
  firstTemplateImageUrl,
  hashTemplateName,
  importTemplateMainImages
} from "../src/application/usecases/importTemplateMainImages.js";

test("extracts the first carousel image from the template workbook rows", () => {
  const rows = [
    ["店铺模板导出", "", ""],
    ["*产品标题", "SKU货号", "*轮播图", "*产品素材图"],
    ["Christmas Stickers", "XMAS-001", "https://img.example/hero-1.png\nhttps://img.example/hero-2.png", "https://img.example/material-1.png"],
    ["Gift Wrap", "WRAP-002", "https://img.example/wrap-1.png|https://img.example/wrap-2.png", ""]
  ];

  const result = importTemplateMainImages(rows, { idPrefix: "excel" });

  assert.equal(result.summary.headerRowNumber, 2);
  assert.equal(result.summary.matchedImageCount, 2);
  assert.equal(result.summary.primaryImageColumn, "*轮播图 (第 3 列)");
  assert.equal(result.items[0].id, "excel-1");
  assert.equal(result.items[0].imageUrl, "https://img.example/hero-1.png");
  assert.equal(result.items[0].sourceColumn, "*轮播图");
  assert.equal(result.items[0].name, "XMAS-001_Christmas Stickers");
  assert.equal(result.items[1].imageUrl, "https://img.example/wrap-1.png");
});

test("falls back to 产品素材图 when no carousel column exists", () => {
  const rows = [
    ["产品标题", "产品货号", "产品素材图"],
    ["Ribbon", "RB-100", "https://img.example/ribbon-a.jpg, https://img.example/ribbon-b.jpg"]
  ];

  const result = importTemplateMainImages(rows);

  assert.equal(result.summary.primaryImageColumn, "");
  assert.equal(result.summary.fallbackImageColumn, "产品素材图 (第 3 列)");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].imageUrl, "https://img.example/ribbon-a.jpg");
  assert.equal(result.items[0].sourceColumn, "产品素材图");
});

test("falls back row-by-row to 产品素材图 when carousel cell is empty", () => {
  const rows = [
    ["产品标题", "SKU货号", "轮播图", "产品素材图"],
    ["Garland", "GAR-1", "", "https://img.example/garland-material.png"]
  ];

  const result = importTemplateMainImages(rows);

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].imageUrl, "https://img.example/garland-material.png");
  assert.equal(result.items[0].sourceColumn, "产品素材图");
});

test("dedupes imported template rows by hashed column A name", () => {
  const rows = [
    ["产品标题", "SKU货号", "轮播图"],
    ["Same Product", "SKU-1", "https://img.example/first.png"],
    ["Same Product", "SKU-2", "https://img.example/second.png"],
    ["Other Product", "SKU-3", "https://img.example/third.png"]
  ];

  const result = importTemplateMainImages(rows);

  assert.deepEqual(result.items.map((item) => item.imageUrl), [
    "https://img.example/first.png",
    "https://img.example/third.png"
  ]);
  assert.equal(result.items[0].sourceNameHash, hashTemplateName("Same Product"));
  assert.equal(result.summary.duplicateNameRowCount, 1);
  assert.equal(result.summary.uniqueNameCount, 2);
});

test("does not dedupe blank column A names", () => {
  const rows = [
    ["产品标题", "SKU货号", "轮播图"],
    ["", "SKU-1", "https://img.example/first.png"],
    ["", "SKU-2", "https://img.example/second.png"]
  ];

  const result = importTemplateMainImages(rows);

  assert.equal(result.items.length, 2);
  assert.equal(result.summary.duplicateNameRowCount, 0);
});

test("finds the template header row within the first scan window", () => {
  const rows = [
    ["说明"],
    ["请勿修改表头"],
    ["产品标题", "轮播图", "SKU货号"]
  ];

  assert.equal(findHeaderRowIndex(rows), 2);
});

test("detects template columns with starred headers", () => {
  const columns = detectTemplateColumns(["*产品标题", "*英文标题", "*轮播图", "*产品素材图", "SKU货号"]);

  assert.equal(columns.titleColumn, 0);
  assert.equal(columns.englishTitleColumn, 1);
  assert.equal(columns.primaryImageColumn, 2);
  assert.equal(columns.fallbackImageColumn, 3);
  assert.equal(columns.skuColumn, 4);
});

test("extracts the first url from a template cell", () => {
  assert.equal(
    firstTemplateImageUrl("https://img.example/one.png；https://img.example/two.png"),
    "https://img.example/one.png"
  );
  assert.equal(firstTemplateImageUrl(""), "");
});
