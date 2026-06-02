export function mergeProductsIntoCollection(existingProducts, incomingProducts) {
  const productsByKey = new Map(existingProducts.map((product) => [productKey(product), product]));
  let addedCount = 0;
  let updatedCount = 0;

  for (const incomingProduct of incomingProducts) {
    const key = productKey(incomingProduct);
    if (!key) continue;

    if (productsByKey.has(key)) {
      updatedCount += 1;
    } else {
      addedCount += 1;
    }
    productsByKey.set(key, incomingProduct);
  }

  return {
    products: Array.from(productsByKey.values()),
    addedCount,
    updatedCount
  };
}

export function removeProductsFromCollection(products, productIds) {
  const ids = new Set(productIds.map(String));
  return products.filter((product) => !ids.has(productKey(product)));
}

export function selectProductsFromCollection(products, productIds) {
  const ids = new Set(productIds.map(String));
  return products.filter((product) => ids.has(productKey(product)));
}

function productKey(product) {
  return String(product?.id || product?.skc || "").trim();
}
