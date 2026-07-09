import type { CartTransformRunInput, CartTransformRunResult } from "../generated/api";
import { computeLineTotal, unitAmountForLineUpdate } from "./pricing";
import type { PriceTable, AddonFees } from "./pricing";

const NO_CHANGES: CartTransformRunResult = { operations: [] };

type LineAttribute = { key: string; value?: string | null } | null | undefined;

// lineUpdate is restricted to Shopify Plus / Development-plan stores. lineExpand
// has no such restriction, so a single-item expand (same variant, same quantity,
// adjusted price) is used as the price-override mechanism instead. Unlike
// lineUpdate, expand does not carry the original line's properties over to the
// new line automatically — ExpandedItem.attributes must be set explicitly from
// the properties fetched in the input query.
function collectAttributes(attrs: LineAttribute[]): Array<{ key: string; value: string }> {
  return attrs
    .filter((attr): attr is { key: string; value: string } => !!attr?.value)
    .map(({ key, value }) => ({ key, value }));
}

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

    // Function input queries have a max complexity of 30, and each individual
    // attribute(key:) lookup costs 2 — not enough budget to query all ~22
    // `_`-prefixed properties individually. The pricing-relevant ones are kept
    // as their own named attributes; everything else (headings, verse, design,
    // numbering range, notes, upload URLs, etc.) is written by the theme wizard
    // as a single JSON-encoded `_config_json` attribute and passed through
    // opaquely here without the function needing to parse it.
    const attributes = collectAttributes([
      line.specialNumbering,
      line.specials,
      line.holyDaysCount,
      line.configJson,
    ]);

    operations.push({
      lineExpand: {
        cartLineId: line.id,
        expandedCartItems: [
          {
            merchandiseId: line.merchandise.id,
            quantity: line.quantity,
            attributes,
            price: {
              adjustment: {
                fixedPricePerUnit: { amount: unitAmountForLineUpdate(lineTotal, line.quantity) },
              },
            },
          },
        ],
      },
    });
  }

  return operations.length > 0 ? { operations } : NO_CHANGES;
}
