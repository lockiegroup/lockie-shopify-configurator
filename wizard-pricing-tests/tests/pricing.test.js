import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import path from "path";
import fixtures from "../../pricing-fixtures.json";
import weeklyPriceTable from "../../price-table-weekly.json";
import economyPriceTable from "../../price-table-economy.json";
import lbsPriceTable from "../../price-table-lbs.json";
import weeklyAddonFees from "../../addon-fees-weekly.json";
import economyAddonFees from "../../addon-fees-economy.json";
import lbsAddonFees from "../../addon-fees-lbs.json";

// pricing.js is a plain UMD script, loaded via <script> in the theme with no
// bundler — it must stay a plain CommonJS-style .js file for that to work.
// A regular require()/createRequire() would normally handle that fine from
// this ESM test, but this repo's root package.json sets "type": "module",
// and pricing.js has no package.json of its own to override that (its
// directory, extensions/configurator-wizard/, may only contain
// assets/blocks/snippets/locales — no package.json allowed there, which is
// why this whole test package lives outside the extension). Node would
// therefore misparse it as ESM and crash inside the UMD wrapper. Loading it
// through a manual CommonJS wrapper — the same technique Node's own module
// loader uses internally — sidesteps that file-type detection entirely.
function loadUmdAsCommonJs(absPath) {
  const source = readFileSync(absPath, "utf8");
  const mod = { exports: {} };
  const localRequire = createRequire(absPath);
  const wrapper = new Function("module", "exports", "require", "__filename", "__dirname", source);
  wrapper(mod, mod.exports, localRequire, absPath, path.dirname(absPath));
  return mod.exports;
}

const pricingPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../extensions/configurator-wizard/assets/pricing.js"
);
const { computeLineTotal, countExcluded, numberingMatch, hasSpecialNumbering } = loadUmdAsCommonJs(pricingPath);

const TABLES_BY_TIER = {
  weekly: { priceTable: weeklyPriceTable, addonFees: weeklyAddonFees },
  economy: { priceTable: economyPriceTable, addonFees: economyAddonFees },
  lbs: { priceTable: lbsPriceTable, addonFees: lbsAddonFees },
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

// The £12 special-numbering fee is no longer a customer-facing yes/no toggle
// — it's derived from whether the numbering range has valid exclusions (see
// hasSpecialNumbering's own header comment in pricing.js). These cases pin
// down that derivation so the live-summary £12 and the checkout-charged £12
// (Stage 3's _special_numbering line item property, once wired) can never
// disagree about when the fee applies.
describe("hasSpecialNumbering (the £12 fee trigger)", () => {
  it("is false for a clean sequential run with no exclusions", () => {
    expect(hasSpecialNumbering({ num_from: "1", num_to: "52", excluded: "" })).toBe(false);
  });

  it("is true once at least one valid in-range exclusion is present", () => {
    expect(hasSpecialNumbering({ num_from: "1", num_to: "53", excluded: "13" })).toBe(true);
  });

  it("ignores out-of-range exclusions — does not trigger the fee", () => {
    expect(hasSpecialNumbering({ num_from: "1", num_to: "52", excluded: "9999" })).toBe(false);
  });

  it("ignores non-numeric/typo exclusions — does not trigger the fee", () => {
    expect(hasSpecialNumbering({ num_from: "1", num_to: "52", excluded: "abc" })).toBe(false);
  });

  it("is false when no range has been entered yet", () => {
    expect(hasSpecialNumbering({ num_from: "", num_to: "", excluded: "13" })).toBe(false);
  });

  it("dedupes repeated exclusions rather than double counting", () => {
    const match = numberingMatch({ num_from: "1", num_to: "53", excluded: "13, 13, 13" });
    expect(match.excludedCount).toBe(1);
    expect(match.effectiveCount).toBe(52);
  });
});

describe("countExcluded", () => {
  it("counts only distinct, numeric, in-range entries", () => {
    expect(countExcluded("13, 44, 44, 9999, abc, 20", 1, 52)).toBe(3);
  });
});

// End-to-end proof that the derived trigger produces the same checkout total
// as the old explicit-toggle fixture ("Weekly qty 52 + special numbering + 2
// specials" above, £163.32): a customer who types a from/to range with one
// valid exclusion is charged identically to the old "Yes" toggle case.
describe("Derived trigger produces the same total as the retired toggle", () => {
  it("Weekly qty 52, range 1-53 excluding 13, + 2 specials matches £163.32", () => {
    const state = { num_from: "1", num_to: "53", excluded: "13" };
    expect(hasSpecialNumbering(state)).toBe(true);
    const total = computeLineTotal({
      qty: 52,
      priceTable: weeklyPriceTable,
      addonFees: weeklyAddonFees,
      specialNumbering: hasSpecialNumbering(state),
      specialsCount: 2,
      holyDaysCount: 0,
    });
    expect(total).toBe(163.32);
  });
});
