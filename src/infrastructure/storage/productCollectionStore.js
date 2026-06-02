import {
  mergeProductsIntoCollection,
  removeProductsFromCollection
} from "../../application/usecases/productCollection.js";

const PRODUCT_COLLECTION_KEY = "t2ProductCollection";

export async function loadProductCollection() {
  const result = await chrome.storage.local.get(PRODUCT_COLLECTION_KEY);
  const products = result[PRODUCT_COLLECTION_KEY];
  return Array.isArray(products) ? structuredClone(products) : [];
}

export async function addProductsToCollection(products) {
  const existingProducts = await loadProductCollection();
  const result = mergeProductsIntoCollection(existingProducts, products);
  await saveProductCollection(result.products);
  return result;
}

export async function removeProductIdsFromCollection(productIds) {
  const existingProducts = await loadProductCollection();
  const products = removeProductsFromCollection(existingProducts, productIds);
  await saveProductCollection(products);
  return products;
}

export async function clearProductCollection() {
  await saveProductCollection([]);
}

export function listenForProductCollectionChanges(callback) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[PRODUCT_COLLECTION_KEY]) {
      callback();
    }
  });
}

async function saveProductCollection(products) {
  await chrome.storage.local.set({
    [PRODUCT_COLLECTION_KEY]: structuredClone(products)
  });
}
