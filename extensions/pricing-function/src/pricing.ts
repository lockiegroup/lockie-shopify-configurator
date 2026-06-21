export type PriceBand = {
  from: number;
  to: number;
  unit: number;
};

export type PriceTable = {
  currency: string;
  rounding: string;
  bands: PriceBand[];
};

export type AddonFee = {
  label: string;
  amount: number;
  type: string;
};

export type AddonFees = Record<string, AddonFee>;

export type LineInput = {
  qty: number;
  priceTable: PriceTable;
  addonFees: AddonFees;
  specialNumbering: boolean;
  specialsCount: number;
  holyDaysCount: number;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function findUnitPrice(bands: PriceBand[], qty: number): number {
  const band = bands.find((b) => qty >= b.from && qty <= b.to);
  if (!band) throw new Error(`No price band covers quantity ${qty}`);
  return band.unit;
}

/**
 * Computes the rounded line total from the price table + add-on fees.
 * Matches the formula in CLAUDE.md and must stay identical to the front-end display calc.
 *
 * base_total   = round2(unit_price × qty)
 * addons_total = special_numbering_flat
 *              + Σ(extra_envelope.amount × specialsCount × qty)
 *              + Σ(holyday_special.amount × holyDaysCount × qty)
 * line_total   = round2(base_total + addons_total)
 */
export function computeLineTotal(input: LineInput): number {
  const { qty, priceTable, addonFees, specialNumbering, specialsCount, holyDaysCount } = input;

  const unitPrice = findUnitPrice(priceTable.bands, qty);
  const baseTotal = round2(unitPrice * qty);

  let addonsTotal = 0;

  if (specialNumbering) {
    const fee = addonFees["special_numbering"];
    if (fee?.type === "flat") addonsTotal += fee.amount;
  }

  if (specialsCount > 0) {
    const fee = addonFees["extra_envelope"];
    if (fee?.type === "per_unit_per_set") addonsTotal += fee.amount * specialsCount * qty;
  }

  if (holyDaysCount > 0) {
    const fee = addonFees["holyday_special"];
    if (fee?.type === "per_unit_per_set") addonsTotal += fee.amount * holyDaysCount * qty;
  }

  return round2(baseTotal + addonsTotal);
}

/**
 * Converts a rounded line total back to a per-unit amount for Shopify's
 * lineUpdate.price.adjustment.fixedPricePerUnit.amount field.
 * Nine decimal places so qty × unit rounds to the correct line total.
 */
export function unitAmountForLineUpdate(lineTotal: number, qty: number): string {
  return (lineTotal / qty).toFixed(9);
}
