import type { Trade } from "./api";

function formatTradeQuantity(quantity?: number | null): string {
  if (quantity === null || quantity === undefined || Number.isNaN(quantity)) {
    return "1";
  }

  if (Number.isInteger(quantity)) {
    return String(quantity);
  }

  return quantity.toFixed(2).replace(/\.00$/, "");
}

export function formatTradeLabel(side: Trade["side"], quantity?: number | null): string {
  return `${side.toUpperCase()} ${formatTradeQuantity(quantity)}`;
}
