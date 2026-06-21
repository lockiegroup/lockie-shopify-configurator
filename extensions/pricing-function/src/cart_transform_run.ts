import type { CartTransformRunResult } from "../generated/api";
import { computeLineTotal, unitAmountForLineUpdate } from "./pricing";
import type { PriceTable, AddonFees } from "./pricing";

// Local types describing the cart line shape after running `shopify app function typegen`.
// Until typegen is re-run against the updated GraphQL query, CartTransformRunInput from
// generated/api.ts won't include these fields, so we cast the input below.
type RichCartLine = {
  id: string;
  quantity: number;
  specialNumbering?: { value?: string | null } | null;
  specials?: { value?: string | null } | null;
  holyDaysCount?: { value?: string | null } | null;
  merchandise?: {
    product?: {
      priceTable?: { jsonValue: unknown } | null;
      addonFees?: { jsonValue: unknown } | null;
    } | null;
  } | null;
};

type RichInput = { cart: { lines: RichCartLine[] } };

const NO_CHANGES: CartTransformRunResult = { operations: [] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cartTransformRun(input: any): CartTransformRunResult {
  const { cart } = input as RichInput;
  const operations: CartTransformRunResult["operations"] = [];

  for (const line of cart.lines) {
    const product = line.merchandise?.product;

    // No price_table metafield = Tier 1 product; leave price untouched.
    if (!product?.priceTable?.jsonValue) continue;

    const priceTable = product.priceTable.jsonValue as PriceTable;
    const addonFees = (product.addonFees?.jsonValue ?? {}) as AddonFees;

    const specialNumbering = line.specialNumbering?.value === "yes";
    const specialsCsv = line.specials?.value ?? "";
    const specialsCount = specialsCsv ? specialsCsv.split(",").filter(Boolean).length : 0;
    const holyDaysCount = parseInt(line.holyDaysCount?.value ?? "0", 10) || 0;

    const lineTotal = computeLineTotal({
      qty: line.quantity,
      priceTable,
      addonFees,
      specialNumbering,
      specialsCount,
      holyDaysCount,
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
