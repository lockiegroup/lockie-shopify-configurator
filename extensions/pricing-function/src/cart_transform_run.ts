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

type LabelValuePair = [string, unknown];

// The wizard bundles every non-pricing-critical field (headings, verse,
// design, numbering range, notes, plus the audit-only calc_unit_price/
// calc_line_total) into ONE _display_fields_json attribute so fetching it
// costs a single query-complexity unit — see the cap note on `attributes`
// below for why that matters. This explodes it into individually-keyed
// attributes on the way OUT, which isn't complexity-limited (only the input
// query is), so the final order ends up with clean "Label: Value" rows
// instead of a JSON blob without the Function's query ever exceeding its
// 30-point cap. `display` entries become customer/office-visible attributes
// (no underscore); `audit` entries are re-hidden with a `_` prefix — same
// mechanism, different purpose, both free once the one JSON attribute is in
// hand.
function explodeDisplayFields(json: string | null | undefined): Array<{ key: string; value: string }> {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const { display, audit } = parsed as { display?: LabelValuePair[]; audit?: LabelValuePair[] };

  const toAttributes = (pairs: LabelValuePair[] | undefined, keyPrefix: string) =>
    (Array.isArray(pairs) ? pairs : [])
      .filter((pair): pair is LabelValuePair => Array.isArray(pair) && pair.length === 2)
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([key, value]) => ({ key: keyPrefix + String(key), value: String(value) }));

  return [...toAttributes(display, ""), ...toAttributes(audit, "_")];
}

export function cartTransformRun(input: CartTransformRunInput): CartTransformRunResult {
  const operations: CartTransformRunResult["operations"] = [];

  for (const line of input.cart.lines) {
    // Narrow the merchandise union — CustomProduct has no .product field.
    if (!("product" in line.merchandise)) continue;

    const { priceTable, addonFees } = line.merchandise.product;

    // No price_table metafield = Tier 1 product; leave price untouched.
    if (!priceTable?.jsonValue) continue;

    // The theme wizard is expected to add-to-cart with quantity fixed at 1 and
    // carry the customer's actual box count via the _quantity property — see
    // the note on `amount` below for why. Fall back to the cart line's native
    // quantity if that property is absent (e.g. ad-hoc/manual testing).
    const orderedQty = parseInt(line.orderedQuantity?.value ?? "", 10) || line.quantity;

    const lineTotal = computeLineTotal({
      qty: orderedQty,
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
    // as their own named attributes (hidden — audit/debug only, not meant for
    // customer/office display); everything else (headings, verse, design,
    // numbering range, notes, calc_unit_price/calc_line_total) arrives as one
    // JSON-encoded `_display_fields_json` attribute and is exploded into
    // individually-keyed, human-labelled attributes by explodeDisplayFields
    // above — see its own comment for why this is the one JSON attribute that
    // still fits the complexity cap while producing clean order rows.
    const attributes = [
      ...collectAttributes([line.orderedQuantity, line.specialNumbering, line.specials, line.holyDaysCount]),
      ...explodeDisplayFields(line.displayFieldsJson?.value),
    ];

    // Checkout rounds fixedPricePerUnit to 2dp *before* multiplying by
    // parent_qty × item_qty — confirmed live (qty 52 at "3.140769231"/unit
    // charged as 52 × 3.14 = $163.28, four cents short of $163.32). Band unit
    // rates need up to 9dp to reproduce exact totals, which no 2dp per-unit
    // price can survive once multiplied by a quantity > 1. The only exact fix
    // is to make that multiplier 1: expandedItem.quantity is already pinned at
    // 1 (see below), so when the parent line's own quantity is also 1 (the
    // wizard's job), the "per unit" amount can just be the full line total —
    // no multiplication, no rounding drift. If line.quantity isn't 1 (legacy/
    // ad-hoc testing), fall back to dividing by it, matching prior behaviour.
    const amount = line.quantity === 1
      ? lineTotal.toFixed(2)
      : unitAmountForLineUpdate(lineTotal, line.quantity);

    operations.push({
      lineExpand: {
        cartLineId: line.id,
        expandedCartItems: [
          {
            merchandiseId: line.merchandise.id,
            // ExpandedItem.quantity is "units of this component per one unit of
            // the parent line" — Shopify multiplies it by the parent line's own
            // quantity. Since this is a 1:1 price override (not a real bundle),
            // that must be 1, not line.quantity — otherwise the final count
            // becomes line.quantity² (52 × 52 = 2704, observed live).
            quantity: 1,
            attributes,
            price: {
              adjustment: {
                fixedPricePerUnit: { amount },
              },
            },
          },
        ],
      },
    });
  }

  return operations.length > 0 ? { operations } : NO_CHANGES;
}
