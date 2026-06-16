const T2_RESULT_PRODUCTS_KEY = "t2IntersectionProducts";
const T2_RESULT_SUMMARY_KEY = "t2IntersectionSummary";
const T2_RESULT_DUPLICATE_PRICE_SKCS_KEY = "t2IntersectionDuplicatePriceSkcs";

export async function saveT2IntersectionResult({ products, summary, duplicatePriceSkcs = [] }) {
  await chrome.storage.local.set({
    [T2_RESULT_PRODUCTS_KEY]: products,
    [T2_RESULT_SUMMARY_KEY]: summary,
    [T2_RESULT_DUPLICATE_PRICE_SKCS_KEY]: duplicatePriceSkcs
  });
}

export async function loadT2IntersectionResult() {
  const result = await chrome.storage.local.get([
    T2_RESULT_PRODUCTS_KEY,
    T2_RESULT_SUMMARY_KEY,
    T2_RESULT_DUPLICATE_PRICE_SKCS_KEY
  ]);
  return {
    products: Array.isArray(result[T2_RESULT_PRODUCTS_KEY]) ? result[T2_RESULT_PRODUCTS_KEY] : [],
    summary: result[T2_RESULT_SUMMARY_KEY] || null,
    duplicatePriceSkcs: Array.isArray(result[T2_RESULT_DUPLICATE_PRICE_SKCS_KEY])
      ? result[T2_RESULT_DUPLICATE_PRICE_SKCS_KEY]
      : []
  };
}

export function listenForT2IntersectionResultChanges(callback) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (
      changes[T2_RESULT_PRODUCTS_KEY] ||
      changes[T2_RESULT_SUMMARY_KEY] ||
      changes[T2_RESULT_DUPLICATE_PRICE_SKCS_KEY]
    ) {
      callback();
    }
  });
}
