import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import path from "path";
import fixtures from "../../pricing-fixtures.json";
import weeklyPriceTable from "../../price-table-weekly.json";
import economyPriceTable from "../../price-table-economy.json";
import weeklyAddonFees from "../../addon-fees-weekly.json";
import economyAddonFees from "../../addon-fees-economy.json";

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
const { computeLineTotal } = loadUmdAsCommonJs(pricingPath);

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
