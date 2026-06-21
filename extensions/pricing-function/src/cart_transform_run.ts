import type { CartTransformRunInput, CartTransformRunResult } from "../generated/api";
import { computeLineTotal, unitAmountForLineUpdate } from "./pricing";
import type { PriceTable, AddonFees } from "./pricing";

const NO_CHANGES: CartTransformRunResult = { operations: [] };

export function cartTransformRun(input: CartTransformRunInput): CartTransformRunResult {
  const operations: CartTransformRunResult["operations"] = [];

  for (const line of input.cart.lines) {
    // Narrow the merchandise union — CustomProduct has no .product field.
    if (!("product" in line.merchandise)) continue;

    const { priceTable, addonFees } = line.merchandise.product;

    // No price_table metafield = Tier 1 product; leave price untouched.
    if (!priceTable?.jsonValue) continue;

    const lineTotal = computeLineTotal({
      qty: line.quantity,
      priceTable: priceTable.jsonValue as PriceTable,
      addonFees: (addonFees?.jsonValue ?? {}) as AddonFees,
      specialNumbering: line.specialNumbering?.value === "yes",
      specialsCount: line.specials?.value
        ? line.specials.value.split(",").filter(Boolean).length
        : 0,
      holyDaysCount: parseInt(line.holyDaysCount?.value ?? "0", 10) || 0,
    });

    operations.push({
      lineUpdate: {
        cartLineId: line.id,
        price: {
          adjustment: {
            fixedPricePerUnit: { amount: unitAmountForLineUpdate(lineTotal, line.quantity) },
          },
        },
      },
    });
  }

  return operations.length > 0 ? { operations } : NO_CHANGES;
}
