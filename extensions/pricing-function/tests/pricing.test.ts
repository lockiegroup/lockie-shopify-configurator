import { describe, it, expect } from "vitest";
import { computeLineTotal } from "../src/pricing";
import type { PriceTable, AddonFees } from "../src/pricing";
import weeklyPriceTableJson from "../../../price-table-weekly.json";
import economyPriceTableJson from "../../../price-table-economy.json";
import lbsPriceTableJson from "../../../price-table-lbs.json";
import mesPriceTableJson from "../../../price-table-mes.json";
import weeklyAddonFeesJson from "../../../addon-fees-weekly.json";
import economyAddonFeesJson from "../../../addon-fees-economy.json";
import lbsAddonFeesJson from "../../../addon-fees-lbs.json";
import mesAddonFeesJson from "../../../addon-fees-mes.json";
import fixtures from "../../../pricing-fixtures.json";

const WEEKLY_PRICE_TABLE = weeklyPriceTableJson as PriceTable;
const ECONOMY_PRICE_TABLE = economyPriceTableJson as PriceTable;
const LBS_PRICE_TABLE = lbsPriceTableJson as PriceTable;
const MES_PRICE_TABLE = mesPriceTableJson as PriceTable;
const WEEKLY_ADDON_FEES = weeklyAddonFeesJson as AddonFees;
const ECONOMY_ADDON_FEES = economyAddonFeesJson as AddonFees;
const LBS_ADDON_FEES = lbsAddonFeesJson as AddonFees;
const MES_ADDON_FEES = mesAddonFeesJson as AddonFees;

const TABLES_BY_TIER: Record<string, { priceTable: PriceTable; addonFees: AddonFees }> = {
  weekly: { priceTable: WEEKLY_PRICE_TABLE, addonFees: WEEKLY_ADDON_FEES },
  economy: { priceTable: ECONOMY_PRICE_TABLE, addonFees: ECONOMY_ADDON_FEES },
  lbs: { priceTable: LBS_PRICE_TABLE, addonFees: LBS_ADDON_FEES },
  mes: { priceTable: MES_PRICE_TABLE, addonFees: MES_ADDON_FEES },
};

// These fixtures are the single source of truth for expected totals, shared
// with the wizard's own pricing.js test (extensions/configurator-wizard/tests).
// Both implementations must produce the exact same numbers for the exact same
// inputs, or the wizard's displayed total can drift from what checkout
// actually charges — a case in this same file caught that class of bug once
// already (the qty-52 rounding-drift fix documented in CLAUDE.md).
describe("Shared pricing fixtures (pricing-fixtures.json)", () => {
  for (const fixture of fixtures as Array<{
    name: string;
    tier: string;
    qty: number;
    specialNumbering: boolean;
    specialsCount: number;
    holyDaysCount: number;
    expectedTotal: number;
  }>) {
    it(fixture.name, () => {
      const { priceTable, addonFees } = TABLES_BY_TIER[fixture.tier];
      expect(
        computeLineTotal({
          qty: fixture.qty,
          priceTable,
          addonFees,
          specialNumbering: fixture.specialNumbering,
          specialsCount: fixture.specialsCount,
          holyDaysCount: fixture.holyDaysCount,
        })
      ).toBe(fixture.expectedTotal);
    });
  }
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
