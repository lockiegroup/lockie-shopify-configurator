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
 * Also owns the numbering-range/exclusion match logic (countExcluded,
 * numberingMatch, hasSpecialNumbering) — not mirrored in pricing.ts, since
 * the Function never sees raw num_from/num_to/excluded (only the
 * already-derived _special_numbering flag, per the Function input query
 * complexity cap in CLAUDE.md). It lives here rather than in configurator.js
 * so it gets the same fixture/unit-test coverage as the money math, since it
 * now directly decides whether the £12 fee applies.
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

  // Counts distinct excluded numbers that actually fall inside [from, to] —
  // typos or out-of-range entries shouldn't silently count toward the £12
  // special-numbering trigger or the range/quantity match.
  function countExcluded(excludedStr, from, to) {
    var seen = {};
    (excludedStr || "").split(",").forEach(function (part) {
      var n = parseInt(part.trim(), 10);
      if (!isNaN(n) && n >= from && n <= to) seen[n] = true;
    });
    return Object.keys(seen).length;
  }

  // The numbered envelopes must match the set quantity exactly: range size
  // minus valid exclusions has to equal qty, or fulfilment prints the wrong
  // count of numbered envelopes for the boxes actually being sent.
  function numberingMatch(state) {
    var from = +state.num_from;
    var to = +state.num_to;
    if (!state.num_from || !state.num_to || isNaN(from) || isNaN(to) || to < from) return null;
    var rangeCount = to - from + 1;
    var excludedCount = countExcluded(state.excluded, from, to);
    return { rangeCount: rangeCount, excludedCount: excludedCount, effectiveCount: rangeCount - excludedCount };
  }

  // Single source of truth for "does this line owe the £12 special-numbering
  // fee". A clean sequential run (no valid exclusions) is standard and free;
  // the fee applies the moment at least one in-range exclusion makes the run
  // non-continuous. Both the wizard's live £12 summary line and (Stage 3) the
  // _special_numbering line item property written at add-to-cart must derive
  // from this same function so they can never disagree about when it's owed.
  function hasSpecialNumbering(state) {
    var match = numberingMatch(state);
    return !!match && match.excludedCount > 0;
  }

  return {
    round2: round2,
    findUnitPrice: findUnitPrice,
    computeLineTotal: computeLineTotal,
    countExcluded: countExcluded,
    numberingMatch: numberingMatch,
    hasSpecialNumbering: hasSpecialNumbering,
  };
});
