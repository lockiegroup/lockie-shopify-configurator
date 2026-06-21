import { describe, it, expect } from "vitest";
import { computeLineTotal } from "../src/pricing";
import type { PriceTable, AddonFees } from "../src/pricing";
import weeklyPriceTableJson from "../../../price-table-weekly.json";

const WEEKLY_PRICE_TABLE = weeklyPriceTableJson as PriceTable;

const WEEKLY_ADDON_FEES: AddonFees = {
  special_numbering: { label: "Special numbering", amount: 12.00, type: "flat" },
  extra_envelope:    { label: "Additional special envelope", amount: 0.05, type: "per_unit_per_set" },
  printed_extra:     { label: "Printed additional envelope", amount: 0.01, type: "per_unit_per_set" },
  holyday_special:   { label: "Holyday special", amount: 0.05, type: "per_unit_per_set" },
};

function base(qty: number) {
  return computeLineTotal({
    qty,
    priceTable: WEEKLY_PRICE_TABLE,
    addonFees: WEEKLY_ADDON_FEES,
    specialNumbering: false,
    specialsCount: 0,
    holyDaysCount: 0,
  });
}

describe("Weekly base totals — no add-ons (matches WooCommerce verified values)", () => {
  it("qty 20  → £76.67",  () => expect(base(20)).toBe(76.67));
  it("qty 52  → £146.12", () => expect(base(52)).toBe(146.12));
  it("qty 100 → £220.30", () => expect(base(100)).toBe(220.30));
  it("qty 200 → £427.42", () => expect(base(200)).toBe(427.42));
  it("qty 500 → £925.01", () => expect(base(500)).toBe(925.01));
});

describe("Weekly pricing — add-on combinations", () => {
  it("52 sets + special numbering (£12 flat) → £158.12", () => {
    expect(
      computeLineTotal({
        qty: 52,
        priceTable: WEEKLY_PRICE_TABLE,
        addonFees: WEEKLY_ADDON_FEES,
        specialNumbering: true,
        specialsCount: 0,
        holyDaysCount: 0,
      })
    ).toBe(158.12);
  });

  it("52 sets + special numbering + 2 specials (2 × £0.05 × 52 = £5.20) → £163.32", () => {
    expect(
      computeLineTotal({
        qty: 52,
        priceTable: WEEKLY_PRICE_TABLE,
        addonFees: WEEKLY_ADDON_FEES,
        specialNumbering: true,
        specialsCount: 2,
        holyDaysCount: 0,
      })
    ).toBe(163.32);
  });
});

describe("Edge cases", () => {
  it("returns 0 add-ons when specialsCount is 0 and holyDaysCount is 0", () => {
    const withAddons = computeLineTotal({
      qty: 20,
      priceTable: WEEKLY_PRICE_TABLE,
      addonFees: WEEKLY_ADDON_FEES,
      specialNumbering: false,
      specialsCount: 0,
      holyDaysCount: 0,
    });
    expect(withAddons).toBe(76.67);
  });

  it("throws for a quantity that falls outside all bands", () => {
    expect(() =>
      computeLineTotal({
        qty: 1,
        priceTable: WEEKLY_PRICE_TABLE,
        addonFees: WEEKLY_ADDON_FEES,
        specialNumbering: false,
        specialsCount: 0,
        holyDaysCount: 0,
      })
    ).toThrow("No price band covers quantity 1");
  });
});
