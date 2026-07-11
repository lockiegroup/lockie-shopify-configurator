import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import fixtures from "../../../pricing-fixtures.json";
import weeklyPriceTable from "../../../price-table-weekly.json";
import economyPriceTable from "../../../price-table-economy.json";
import weeklyAddonFees from "../../../addon-fees-weekly.json";
import economyAddonFees from "../../../addon-fees-economy.json";

// pricing.js is a plain UMD script (loaded via <script> in the theme, no
// bundler) — createRequire gets us Node's CommonJS loader from this ESM
// test file without needing any build step.
const require = createRequire(import.meta.url);
const { computeLineTotal } = require("../assets/pricing.js");

const TABLES_BY_TIER = {
  weekly: { priceTable: weeklyPriceTable, addonFees: weeklyAddonFees },
  economy: { priceTable: economyPriceTable, addonFees: economyAddonFees },
};

// Same fixture file the Function's pricing.ts test runs
// (extensions/pricing-function/tests/pricing.test.ts) — the point of Stage 2
// is that these two implementations can never quietly disagree.
describe("Wizard pricing.js matches the shared fixtures (pricing-fixtures.json)", () => {
  for (const fixture of fixtures) {
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
  it("throws for a quantity that falls outside all bands", () => {
    expect(() =>
      computeLineTotal({
        qty: 1,
        priceTable: weeklyPriceTable,
        addonFees: weeklyAddonFees,
        specialNumbering: false,
        specialsCount: 0,
        holyDaysCount: 0,
      })
    ).toThrow("No price band covers quantity 1");
  });
});
