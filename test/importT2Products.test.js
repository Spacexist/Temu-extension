import assert from "node:assert/strict";
import test from "node:test";
import {
  extractUniquePriceSkcText,
  importT2Products
} from "../src/application/usecases/importT2Products.js";

function rowWith(columns) {
  const row = [];
  for (const [oneBasedIndex, value] of Object.entries(columns)) {
    row[Number(oneBasedIndex) - 1] = value;
  }
  return row;
}

test("imports the deduped SKC intersection using the max price per SKC", () => {
  const infoRows = [
    rowWith({ 1: "NAME", 10: "images", 56: "SKC" }),
    rowWith({ 1: "Lamp", 10: "https://img.example/lamp-a.png|https://img.example/lamp-b.png", 56: "1001.0" }),
    rowWith({ 1: "Duplicate Lamp", 10: "https://img.example/duplicate.png", 56: "1001" }),
    rowWith({ 1: "Shelf", 10: "https://img.example/shelf.png", 56: "2002" }),
    rowWith({ 1: "No Price", 10: "https://img.example/missing.png", 56: "3003" })
  ];
  const priceRows = [
    rowWith({ 1: "SKC", 7: "quoted price" }),
    rowWith({ 1: "1001", 7: "$12.50" }),
    rowWith({ 1: "2002", 7: "$20.00" }),
    rowWith({ 1: "1001", 7: "99.99" })
  ];

  const result = importT2Products({ infoRows, priceRows });

  assert.deepEqual(result.summary, {
    infoRowCount: 4,
    infoUniqueSkcCount: 3,
    priceUniqueSkcCount: 2,
    matchedProductCount: 2,
    duplicatePriceSkcCount: 1,
    duplicatePriceRowCount: 2
  });
  assert.deepEqual(result.products.map((product) => ({
    id: product.id,
    name: product.name,
    skc: product.skc,
    quotedPrice: product.quotedPrice,
    imageUrl: product.imageUrl,
    status: product.status
  })), [
    {
      id: "t2-1001",
      name: "Lamp",
      skc: "1001",
      quotedPrice: 99.99,
      imageUrl: "https://img.example/lamp-a.png",
      status: "imported"
    },
    {
      id: "t2-2002",
      name: "Shelf",
      skc: "2002",
      quotedPrice: 20,
      imageUrl: "https://img.example/shelf.png",
      status: "imported"
    }
  ]);
  assert.deepEqual(result.duplicatePriceSkcRows.map((row) => ({
    skc: row.skc,
    rowNumber: row.rowNumber,
    occurrenceCount: row.occurrenceCount,
    rawQuotedPrice: row.rawQuotedPrice,
    quotedPrice: row.quotedPrice,
    selectedQuotedPrice: row.selectedQuotedPrice,
    isSelectedMax: row.isSelectedMax
  })), [
    {
      skc: "1001",
      rowNumber: 2,
      occurrenceCount: 2,
      rawQuotedPrice: "$12.50",
      quotedPrice: 12.5,
      selectedQuotedPrice: 99.99,
      isSelectedMax: false
    },
    {
      skc: "1001",
      rowNumber: 4,
      occurrenceCount: 2,
      rawQuotedPrice: "99.99",
      quotedPrice: 99.99,
      selectedQuotedPrice: 99.99,
      isSelectedMax: true
    }
  ]);
  assert.deepEqual(result.duplicatePriceSkcs, [
    {
      skc: "1001",
      occurrenceCount: 2,
      rowNumbers: [2, 4],
      quotedPrices: [12.5, 99.99],
      rawQuotedPrices: ["$12.50", "99.99"],
      selectedQuotedPrice: 99.99,
      selectedRowNumbers: [4]
    }
  ]);
  assert.equal(result.priceHeaderRow[0], "SKC");
});

test("extracts unique price SKC text from column A starting at A2", () => {
  const priceRows = [
    rowWith({ 1: "SKC header should be skipped" }),
    rowWith({ 1: "1001.0", 7: "12.5" }),
    rowWith({ 1: " " }),
    rowWith({ 2: "A column is empty" }),
    rowWith({ 1: "2002" }),
    rowWith({ 1: "1001" }),
    rowWith({ 1: "3003", 7: "99" })
  ];

  assert.equal(extractUniquePriceSkcText(priceRows), "1001,2002,3003");
});
