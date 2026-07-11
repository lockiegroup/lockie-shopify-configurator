/**
 * Lockie Church configurator — shared price-calc core.
 *
 * Mirrors extensions/pricing-function/src/pricing.ts line-for-line. The two
 * can't literally share a module (browser JS here vs. the Function's own
 * Wasm build there), so this is deliberate duplication — kept honest by
 * running both against the exact same cases in pricing-fixtures.json (see
 * tests/pricing.test.js here and extensions/pricing-function/tests/pricing.test.ts).
 * If this ever drifts from pricing.ts, the wizard's displayed total stops
 * matching what checkout actually charges — CLAUDE.md is explicit that the
 * Function's number is the only one that's ever trusted, but a diverging
 * display number is still a real bug (a customer-facing "your total changed
 * at checkout" support ticket), so the fixture comparison exists to catch it
 * before it ships.
 *
 * UMD wrapper: exposes window.LockieConfiguratorPricing in the browser,
 * module.exports under Node/CommonJS (for the test file) — no bundler needed
 * for a theme app extension asset.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.LockieConfiguratorPricing = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // Matches pricing.ts's round2 exactly — no epsilon fudge.
  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function findUnitPrice(bands, qty) {
    for (var i = 0; i < bands.length; i++) {
      if (qty >= bands[i].from && qty <= bands[i].to) return bands[i].unit;
    }
    throw new Error("No price band covers quantity " + qty);
  }

  /**
   * base_total   = round2(unit_price × qty)
   * addons_total = special_numbering_flat
   *              + Σ(extra_envelope.amount × specialsCount × qty)
   *              + Σ(holyday_special.amount × holyDaysCount × qty)
   * line_total   = round2(base_total + addons_total)
   */
  function computeLineTotal(input) {
    var qty = input.qty;
    var priceTable = input.priceTable;
    var addonFees = input.addonFees;

    var unitPrice = findUnitPrice(priceTable.bands, qty);
    var baseTotal = round2(unitPrice * qty);

    var addonsTotal = 0;

    if (input.specialNumbering) {
      var snFee = addonFees.special_numbering;
      if (snFee && snFee.type === "flat") addonsTotal += snFee.amount;
    }

    if (input.specialsCount > 0) {
      var eeFee = addonFees.extra_envelope;
      if (eeFee && eeFee.type === "per_unit_per_set") addonsTotal += eeFee.amount * input.specialsCount * qty;
    }

    if (input.holyDaysCount > 0) {
      var hdFee = addonFees.holyday_special;
      if (hdFee && hdFee.type === "per_unit_per_set") addonsTotal += hdFee.amount * input.holyDaysCount * qty;
    }

    return round2(baseTotal + addonsTotal);
  }

  return { round2: round2, findUnitPrice: findUnitPrice, computeLineTotal: computeLineTotal };
});
