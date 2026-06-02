export function parseQuantityBoundNumber(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }

  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

export function formatQuantityBoundValue(baseValue, quantity, decimals = 2) {
  const baseNumber = Number(baseValue);
  const quantityNumber = Number(quantity);

  if (!Number.isFinite(baseNumber) || !Number.isFinite(quantityNumber) || quantityNumber <= 0) {
    return "";
  }

  return (baseNumber * quantityNumber).toFixed(decimals);
}
