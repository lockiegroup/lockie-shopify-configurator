/**
 * Lockie Church configurator wizard.
 *
 * Stage 1: step rendering, navigation, and validation, ported from
 * weekly-configurator.html — but every renderer reads its options from the
 * product's own custom.config metafield (injected server-side by the block
 * as inline JSON) instead of a hardcoded CONFIG object. Tier 2 (Weekly) vs
 * Tier 3 (Economy) is entirely a config-shape difference: locked options
 * render as static labels, uploads_enabled:false omits the upload choice,
 * holydays.max bounds the dropdown.
 *
 * Stage 2: live price display, via the shared pricing.js (loaded before this
 * file — see pricing.js's own header for why it's a separate, tested module
 * rather than inlined here). Only qty, specials, holydays, and — since the
 * numbering-refinement pass — the numbering range/exclusions affect price
 * per the formula in CLAUDE.md (special numbering is now derived from
 * exclusions, not a toggle; see hasSpecialNumbering in pricing.js); box/
 * envelope/text colour, headings, verse/design, start date, and notes do
 * not, so refresh() is only wired to the inputs that actually move the total.
 * Display only — add-to-cart wiring is Stage 3.
 *
 * NOTE: verse/design stock lists are not yet in a metafield (metafield-schema.md
 * proposes a shared custom.verses/custom.designs metaobject, not built yet) —
 * ported from the prototype as a temporary hardcoded list pending that work.
 */
(function () {
  var WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  // Temporary — see NOTE above. Identical across Weekly/Economy in the prototype.
  var VERSES = [
    "V1 — All things come from You, O Lord",
    "V2 — Give back some of God's gifts to God",
    "V3 — The Lord blesses His people with peace",
    "V4 — In Thanksgiving to God",
    "V5 — Trust in the Lord with all your heart",
    "V8 — Our gift to God and His Church",
    "V18 — My Weekly Offering",
    "V20 — Our weekly Offering to God",
  ];
  var DESIGNS = ["C1", "C2", "C3", "C5", "D1", "D5", "D29 (Salvation Army)", "D30 (CofE)"];

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function readJSON(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch (err) {
      console.error("[lockie-configurator] failed to parse " + id, err);
      return null;
    }
  }

  function maxQtyFromPriceTable(priceTable, fallback) {
    if (!priceTable || !Array.isArray(priceTable.bands) || priceTable.bands.length === 0) {
      return fallback;
    }
    return priceTable.bands[priceTable.bands.length - 1].to;
  }

  // numberingMatch/hasSpecialNumbering now live in pricing.js (fixture/unit-
  // tested there — see its header comment) since they directly decide
  // whether the £12 special-numbering fee applies. Thin delegates here keep
  // every call site in this file unchanged.
  function numberingMatch(state) {
    return window.LockieConfiguratorPricing.numberingMatch(state);
  }

  function hasSpecialNumbering(state) {
    return window.LockieConfiguratorPricing.hasSpecialNumbering(state);
  }

  function numberingMatchMessage(match, qty) {
    if (!match) return { text: "Enter a numbering range to see how it matches your set count.", ok: false };
    var diff = match.effectiveCount - qty;
    var base = match.rangeCount + " number" + (match.rangeCount === 1 ? "" : "s") + " (range) minus " +
      match.excludedCount + " excluded = " + match.effectiveCount + " numbered envelope" + (match.effectiveCount === 1 ? "" : "s") +
      " for " + qty + " set" + (qty === 1 ? "" : "s") + ".";
    if (diff === 0) return { text: base + " Matches ✓", ok: true };
    if (diff > 0) return { text: base + " Exclude " + diff + " more number" + (diff === 1 ? "" : "s") + " to match.", ok: false };
    return { text: base + " Add " + (-diff) + " more number" + (-diff === 1 ? "" : "s") + " back (widen the range or exclude fewer).", ok: false };
  }

  // Finds the next date (on/after `from`) that falls on `targetDow` (0=Sunday
  // ... 6=Saturday), used to anchor the date input's step grid to the right
  // weekday — see renderStart.
  function nextWeekday(from, targetDow) {
    var d = new Date(from);
    d.setHours(0, 0, 0, 0);
    var add = (targetDow - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + add);
    return d;
  }

  function toDateInputValue(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  /* ========================= STEP DEFINITIONS ========================= */
  // Static UI copy (title/hint) + which config path gates whether the step
  // exists at all + a render/validate pair. Order here is the canonical
  // step order; steps whose config node is missing or enabled:false are
  // skipped entirely (this is how a narrower future tier would drop steps).

  function buildSteps(ctx) {
    var config = ctx.config;
    var steps = config.steps || {};
    var defs = [];

    if (steps.options && steps.options.enabled) {
      defs.push({
        key: "options",
        title: "Quantity & Options",
        hint: "Choose how many sets and your envelope, ink and box options.",
        render: renderOptions,
        validate: function (ctx) {
          var opts = ctx.config.steps.options;
          if (opts.box_colour && !opts.box_colour.locked && !ctx.state.box_colour) {
            return "Please choose a box colour.";
          }
          if (opts.envelope_colour && !opts.envelope_colour.locked && !ctx.state.envelope_colour) {
            return "Please choose an envelope colour.";
          }
          return "";
        },
      });
    }

    if (steps.headings && steps.headings.enabled) {
      defs.push({
        key: "headings",
        title: "Headings & Custom Print",
        hint: "Enter the headings to be printed on your envelopes.",
        render: renderHeadings,
        validate: function (ctx) {
          var lines = ctx.config.steps.headings.lines || [];
          if (lines.length && !ctx.state.headings[lines[0]]) {
            return "Please enter at least the " + lines[0] + ".";
          }
          return "";
        },
      });
    }

    if (steps.design && steps.design.enabled) {
      defs.push({
        key: "design",
        title: "Image Design & Verse",
        hint: "Choose a verse and a design, or supply your own.",
        render: renderDesign,
        validate: function () {
          return "";
        },
      });
    }

    if (steps.numbering && steps.numbering.enabled) {
      defs.push({
        key: "numbering",
        title: "Numbering & Specials",
        hint: "Set your numbering range and any additional collection envelopes.",
        render: renderNumbering,
        validate: function (ctx) {
          var s = ctx.state;
          if (!s.num_from || !s.num_to) return "Enter the from and to numbers for your set.";
          if (+s.num_from < 1) return "Start number must be at least 1.";
          if (+s.num_to < +s.num_from) return "End number must be greater than the start.";
          var match = numberingMatch(s);
          if (!match || match.effectiveCount !== s.qty) {
            return numberingMatchMessage(match, s.qty).text;
          }
          return "";
        },
      });
    }

    if (steps.holydays && steps.holydays.enabled) {
      defs.push({
        key: "holydays",
        title: "Holyday & Diocese Specials",
        hint: "Add diocese holyday specials if required.",
        render: renderHolydays,
        validate: function () {
          return "";
        },
      });
    }

    if (steps.start_date && steps.start_date.enabled) {
      defs.push({
        key: "start_date",
        title: "Start Date",
        hint: "Select the " + (steps.start_date.weekday_only || "") + " your envelope sets should begin.",
        render: renderStart,
        validate: function (ctx) {
          var s = ctx.state;
          if (!s.start_date) return "Please choose a start date.";
          var weekdayOnly = ctx.config.steps.start_date.weekday_only;
          if (weekdayOnly) {
            var expected = WEEKDAYS.indexOf(weekdayOnly);
            var d = new Date(s.start_date);
            if (expected >= 0 && d.getDay() !== expected) {
              return "That's not a " + weekdayOnly + " — please pick a " + weekdayOnly + ".";
            }
          }
          return "";
        },
      });
    }

    if (steps.notes && steps.notes.enabled) {
      defs.push({
        key: "notes",
        title: "Additional Order Details",
        hint: "Anything else we should know about your order.",
        render: renderNotes,
        validate: function () {
          return "";
        },
      });
    }

    return defs;
  }

  /* ========================= RENDERERS ========================= */
  // Each renderer takes (el, ctx) where ctx = { config, state, refresh }.

  function renderOptions(el, ctx) {
    var config = ctx.config;
    var state = ctx.state;
    var minQty = config.min_quantity || 1;
    var maxQty = maxQtyFromPriceTable(ctx.priceTable, minQty + 280);

    var qtyOpts = "";
    for (var q = minQty; q <= maxQty; q++) {
      qtyOpts += '<option value="' + q + '"' + (q === state.qty ? " selected" : "") + ">" + q + "</option>";
    }

    var html =
      '<div class="lockie-configurator__field">' +
      '<label class="lockie-configurator__label">Quantity <span class="lockie-configurator__req">*</span></label>' +
      '<select id="lc-qty">' + qtyOpts + "</select>" +
      '<div class="lockie-configurator__note">Minimum order ' + minQty + " sets.</div>" +
      "</div>";
    el.innerHTML = html;

    var optionFields = [
      { key: "box_colour", label: "Box Colour", required: true },
      { key: "envelope_colour", label: "Envelope Colour", required: true },
      { key: "text_colour", label: "Text Colour", required: false },
    ];

    optionFields.forEach(function (field) {
      var opt = config.steps.options[field.key];
      if (!opt) return;

      var wrap = document.createElement("div");
      wrap.className = "lockie-configurator__field";
      var inner =
        '<label class="lockie-configurator__label">' +
        escapeHtml(field.label) +
        (field.required ? ' <span class="lockie-configurator__req">*</span>' : "") +
        "</label>";

      if (opt.locked) {
        inner += '<span class="lockie-configurator__locked-val">' + escapeHtml(opt.values[0]) + " · fixed</span>";
      } else {
        inner += '<div class="lockie-configurator__swatches" data-group="' + field.key + '">';
        (opt.values || []).forEach(function (v) {
          var oos = (opt.out_of_stock || []).indexOf(v) !== -1;
          inner +=
            '<span class="lockie-configurator__swatch" role="button" data-val="' +
            escapeHtml(v) +
            '" aria-pressed="' +
            (state[field.key] === v) +
            '"' +
            (oos ? ' aria-disabled="true"' : "") +
            ">" +
            escapeHtml(v) +
            (oos ? '<span class="lockie-configurator__oos">out of stock</span>' : "") +
            "</span>";
        });
        inner += "</div>";
      }
      wrap.innerHTML = inner;
      el.appendChild(wrap);
    });

    el.querySelector("#lc-qty").addEventListener("change", function (e) {
      state.qty = +e.target.value;
      ctx.refresh();
    });

    el.querySelectorAll(".lockie-configurator__swatch").forEach(function (s) {
      s.addEventListener("click", function () {
        if (s.getAttribute("aria-disabled") === "true") return;
        var group = s.closest(".lockie-configurator__swatches").dataset.group;
        state[group] = s.dataset.val;
        s.closest(".lockie-configurator__swatches")
          .querySelectorAll(".lockie-configurator__swatch")
          .forEach(function (x) {
            x.setAttribute("aria-pressed", x.dataset.val === state[group]);
          });
      });
    });
  }

  function renderHeadings(el, ctx) {
    var lines = ctx.config.steps.headings.lines || [];
    var state = ctx.state;
    el.innerHTML = lines
      .map(function (h, i) {
        return (
          '<div class="lockie-configurator__field">' +
          '<label class="lockie-configurator__label">' +
          escapeHtml(h) +
          (i === 0 ? ' <span class="lockie-configurator__req">*</span>' : "") +
          "</label>" +
          '<input type="text" data-h="' +
          escapeHtml(h) +
          '" value="' +
          escapeHtml(state.headings[h] || "") +
          '" placeholder="' +
          escapeHtml(h) +
          '">' +
          "</div>"
        );
      })
      .join("");
    el.querySelectorAll("input[data-h]").forEach(function (inp) {
      inp.addEventListener("input", function (e) {
        state.headings[e.target.dataset.h] = e.target.value;
      });
    });
  }

  function renderDesign(el, ctx) {
    var config = ctx.config;
    var state = ctx.state;
    var designConfig = config.steps.design;
    var verseEnabled = designConfig.verse && designConfig.verse.enabled;
    var verseAllowCustom = designConfig.verse && designConfig.verse.allow_custom;
    var designEnabled = designConfig.design && designConfig.design.enabled;
    var uploadAllowed = config.uploads_enabled && designConfig.design && designConfig.design.allow_upload;
    var designAllowCustom = designConfig.design && designConfig.design.allow_custom;

    var html = "";

    if (verseEnabled) {
      html +=
        '<div class="lockie-configurator__field">' +
        '<label class="lockie-configurator__label">Verse</label>' +
        '<select id="lc-verse"><option value="">No verse</option>' +
        VERSES.map(function (v) {
          return '<option' + (state.verse === v ? " selected" : "") + ">" + escapeHtml(v) + "</option>";
        }).join("") +
        (verseAllowCustom ? '<option value="__custom">Add a custom verse…</option>' : "") +
        "</select>";
      if (verseAllowCustom) {
        html +=
          '<div class="lockie-configurator__field" id="lc-cv-wrap" style="margin-top:10px;display:' +
          (state.verse === "__custom" ? "block" : "none") +
          '">' +
          '<input type="text" id="lc-cverse" placeholder="Type your custom verse" value="' +
          escapeHtml(state.custom_verse) +
          '">' +
          "</div>";
      }
      html += "</div>";
    }

    if (designEnabled) {
      html +=
        '<div class="lockie-configurator__field">' +
        '<label class="lockie-configurator__label">Design</label>' +
        '<select id="lc-design"><option value="">No design</option>' +
        DESIGNS.map(function (d) {
          return '<option' + (state.design === d ? " selected" : "") + ">" + escapeHtml(d) + "</option>";
        }).join("") +
        (uploadAllowed ? '<option value="__upload">Upload my own image…</option>' : "") +
        "</select>";
      if (uploadAllowed) {
        html +=
          '<div class="lockie-configurator__field" id="lc-up-wrap" style="margin-top:10px;display:' +
          (state.design === "__upload" ? "block" : "none") +
          '">' +
          '<input type="text" id="lc-upload" placeholder="(prototype) type a filename e.g. our-logo.pdf" value="' +
          escapeHtml(state.upload_name) +
          '">' +
          '<div class="lockie-configurator__note">Accepted: pdf, png, ai, jpg.</div>' +
          "</div>";
      }
      html += "</div>";
    }

    el.innerHTML = html;

    var vs = el.querySelector("#lc-verse");
    if (vs) {
      vs.addEventListener("change", function (e) {
        state.verse = e.target.value;
        var wrap = el.querySelector("#lc-cv-wrap");
        if (wrap) wrap.style.display = e.target.value === "__custom" ? "block" : "none";
      });
    }
    var ds = el.querySelector("#lc-design");
    if (ds) {
      ds.addEventListener("change", function (e) {
        state.design = e.target.value;
        var wrap = el.querySelector("#lc-up-wrap");
        if (wrap) wrap.style.display = e.target.value === "__upload" ? "block" : "none";
      });
    }
    var cv = el.querySelector("#lc-cverse");
    if (cv) cv.addEventListener("input", function (e) { state.custom_verse = e.target.value; });
    var up = el.querySelector("#lc-upload");
    if (up) up.addEventListener("input", function (e) { state.upload_name = e.target.value; });
  }

  function renderNumbering(el, ctx) {
    var config = ctx.config;
    var state = ctx.state;
    var specials = config.steps.numbering.specials || [];
    var extraEnvelopeFee = ctx.addonFees && ctx.addonFees.extra_envelope;
    var extraEnvelopeLabel =
      "Additional special collection envelopes" +
      (extraEnvelopeFee ? " (+" + ctx.formatCurrency(extraEnvelopeFee.amount) + " each)" : "");

    el.innerHTML =
      '<div class="lockie-configurator__field">' +
      '<label class="lockie-configurator__label">Numbering range <span class="lockie-configurator__req">*</span></label>' +
      '<div class="lockie-configurator__row2">' +
      '<div class="lockie-configurator__field"><label class="lockie-configurator__label">Numbered from</label>' +
      '<input type="number" id="lc-nfrom" min="1" value="' +
      escapeHtml(state.num_from) +
      '"></div>' +
      '<div class="lockie-configurator__field"><label class="lockie-configurator__label">Numbered to</label>' +
      '<input type="number" id="lc-nto" min="1" value="' +
      escapeHtml(state.num_to) +
      '"></div>' +
      "</div>" +
      '<div class="lockie-configurator__note" id="lc-num-match"></div>' +
      "</div>" +
      '<div class="lockie-configurator__field" id="lc-excl-wrap" style="display:none">' +
      '<label class="lockie-configurator__label">Excluded numbers</label>' +
      '<input type="text" id="lc-nexcl" placeholder="e.g. 13, 44, 99" value="' +
      escapeHtml(state.excluded) +
      '"><div class="lockie-configurator__note">Numbers to skip in the set.</div>' +
      "</div>" +
      '<div class="lockie-configurator__note" id="lc-sn-notice" style="display:none;color:var(--lc-accent)">' +
      "£12 will be added for special numbering (non-sequential numbers)." +
      "</div>" +
      '<div class="lockie-configurator__field">' +
      '<label class="lockie-configurator__label">' + escapeHtml(extraEnvelopeLabel) + "</label>" +
      '<div class="lockie-configurator__note" style="margin-bottom:8px">Inserted at the back of each set.</div>' +
      '<div class="lockie-configurator__toggle-row">' +
      specials
        .map(function (s) {
          return (
            '<span class="lockie-configurator__chip lc-sp" data-s="' +
            escapeHtml(s) +
            '" aria-pressed="' +
            (state.specials.indexOf(s) !== -1) +
            '">' +
            escapeHtml(s) +
            "</span>"
          );
        })
        .join("") +
      "</div>" +
      "</div>";

    function updateNumberingUI() {
      var match = numberingMatch(state);
      var matchEl = el.querySelector("#lc-num-match");
      var msg = numberingMatchMessage(match, state.qty);
      matchEl.textContent = msg.text;
      matchEl.style.color = msg.ok ? "var(--lc-green)" : "var(--lc-accent)";

      // Exclusions are only needed once the range is wider than the set
      // count — that's how a customer deliberately skips numbers. Once
      // they've typed something there, keep the field visible even if the
      // range is narrowed back down, so it stays editable/clearable.
      var rangeCount = match ? match.rangeCount : 0;
      var showExcluded = rangeCount > state.qty || (state.excluded || "").trim() !== "";
      el.querySelector("#lc-excl-wrap").style.display = showExcluded ? "block" : "none";

      el.querySelector("#lc-sn-notice").style.display = hasSpecialNumbering(state) ? "block" : "none";
    }

    var nfrom = el.querySelector("#lc-nfrom");
    if (nfrom) nfrom.addEventListener("input", function (e) { state.num_from = e.target.value; updateNumberingUI(); ctx.refresh(); });
    var nto = el.querySelector("#lc-nto");
    if (nto) nto.addEventListener("input", function (e) { state.num_to = e.target.value; updateNumberingUI(); ctx.refresh(); });
    var nexcl = el.querySelector("#lc-nexcl");
    if (nexcl) nexcl.addEventListener("input", function (e) { state.excluded = e.target.value; updateNumberingUI(); ctx.refresh(); });

    updateNumberingUI();

    el.querySelectorAll(".lc-sp").forEach(function (c) {
      c.addEventListener("click", function () {
        var s = c.dataset.s;
        var idx = state.specials.indexOf(s);
        if (idx !== -1) state.specials.splice(idx, 1);
        else state.specials.push(s);
        c.setAttribute("aria-pressed", state.specials.indexOf(s) !== -1);
        ctx.refresh();
      });
    });
  }

  function renderHolydays(el, ctx) {
    var max = ctx.config.steps.holydays.max || 0;
    var state = ctx.state;
    var opts = '<option value="0">No holyday specials</option>';
    for (var i = 1; i <= max; i++) {
      opts += '<option value="' + i + '"' + (state.holydays === i ? " selected" : "") + ">+" + i + " special" + (i > 1 ? "s" : "") + "</option>";
    }
    el.innerHTML =
      '<div class="lockie-configurator__field">' +
      '<label class="lockie-configurator__label">Number of holyday specials</label>' +
      '<select id="lc-hd">' + opts + "</select>" +
      '<div class="lockie-configurator__note">Upload your holyday dates template in production.</div>' +
      "</div>";
    el.querySelector("#lc-hd").addEventListener("change", function (e) {
      state.holydays = +e.target.value;
      ctx.refresh();
    });
  }

  function renderStart(el, ctx) {
    var state = ctx.state;
    var weekdayOnly = ctx.config.steps.start_date.weekday_only;
    var expected = weekdayOnly ? WEEKDAYS.indexOf(weekdayOnly) : -1;

    // Anchor the date input's step grid to the target weekday so the native
    // picker only offers matching dates (Chromium greys out the rest).
    // Validation below stays as the fallback for browsers/entry methods
    // that don't honour step in their calendar UI.
    var stepAttrs = "";
    if (expected >= 0) {
      var anchor = toDateInputValue(nextWeekday(new Date(), expected));
      stepAttrs = ' min="' + anchor + '" step="7"';
    }

    el.innerHTML =
      '<div class="lockie-configurator__field">' +
      '<label class="lockie-configurator__label">Start Date <span class="lockie-configurator__req">*</span></label>' +
      '<input type="date" id="lc-sd" value="' +
      escapeHtml(state.start_date) +
      '"' + stepAttrs + '>' +
      (weekdayOnly ? '<div class="lockie-configurator__note">Must be a ' + escapeHtml(weekdayOnly) + ".</div>" : "") +
      '<div class="lockie-configurator__err" id="lc-sd-err"></div>' +
      "</div>";
    el.querySelector("#lc-sd").addEventListener("change", function (e) {
      state.start_date = e.target.value;
      var errEl = el.querySelector("#lc-sd-err");
      if (expected >= 0) {
        var d = new Date(e.target.value);
        errEl.textContent = e.target.value && expected >= 0 && d.getDay() !== expected
          ? "That's not a " + weekdayOnly + " — please pick a " + weekdayOnly + "."
          : "";
      }
    });
  }

  function renderNotes(el, ctx) {
    var state = ctx.state;
    el.innerHTML =
      '<div class="lockie-configurator__field">' +
      '<label class="lockie-configurator__label">Additional order details</label>' +
      '<textarea id="lc-notes" placeholder="Optional notes for our production team">' +
      escapeHtml(state.notes) +
      "</textarea>" +
      "</div>";
    el.querySelector("#lc-notes").addEventListener("input", function (e) {
      state.notes = e.target.value;
    });
  }

  /* ========================= WIZARD SHELL ========================= */

  function createWizard(root) {
    var blockId = root.dataset.blockId;
    var config = readJSON(root.dataset.configId);
    var priceTable = readJSON(root.dataset.priceTableId);
    var addonFees = readJSON(root.dataset.addonFeesId);

    if (!config || !config.steps) {
      console.error("[lockie-configurator] block " + blockId + " has no usable config metafield — nothing to render.");
      return;
    }

    var stepperEl = document.getElementById("lockie-configurator-stepper-" + blockId);
    var stepsEl = document.getElementById("lockie-configurator-steps-" + blockId);
    var addCartEl = document.getElementById("lockie-configurator-addcart-" + blockId);
    var linesEl = document.getElementById("lockie-configurator-lines-" + blockId);
    var totalEl = document.getElementById("lockie-configurator-total-" + blockId);
    var unitNoteEl = document.getElementById("lockie-configurator-unit-note-" + blockId);

    // shop.currency (not the price_table metafield's own "currency" field —
    // that's descriptive only) drives display formatting. The dev store is
    // USD; production will be GBP — see the open item in CLAUDE.md.
    var shopCurrency = root.dataset.shopCurrency || "GBP";
    var totalFormatter = new Intl.NumberFormat("en-GB", { style: "currency", currency: shopCurrency });
    var unitFormatter = new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: shopCurrency,
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    });

    function refreshSummary() {
      if (!window.LockieConfiguratorPricing || !priceTable || !addonFees) return;
      var Pricing = window.LockieConfiguratorPricing;
      var qty = state.qty;
      var specialsCount = state.specials.length;
      var holyDaysCount = state.holydays;

      var unit;
      try {
        unit = Pricing.findUnitPrice(priceTable.bands, qty);
      } catch (err) {
        linesEl.innerHTML = "";
        totalEl.textContent = "—";
        unitNoteEl.textContent = "No price band covers " + qty + " — check the product's price table.";
        return;
      }

      var lines = [{ label: qty + " sets × " + unitFormatter.format(unit), amount: Pricing.round2(unit * qty) }];

      if (hasSpecialNumbering(state) && addonFees.special_numbering && addonFees.special_numbering.type === "flat") {
        lines.push({ label: addonFees.special_numbering.label || "Special numbering", amount: addonFees.special_numbering.amount });
      }
      if (specialsCount > 0 && addonFees.extra_envelope && addonFees.extra_envelope.type === "per_unit_per_set") {
        lines.push({
          label: specialsCount + " special env. × " + qty + " sets",
          amount: Pricing.round2(addonFees.extra_envelope.amount * specialsCount * qty),
        });
      }
      if (holyDaysCount > 0 && addonFees.holyday_special && addonFees.holyday_special.type === "per_unit_per_set") {
        lines.push({
          label: holyDaysCount + " holyday env. × " + qty + " sets",
          amount: Pricing.round2(addonFees.holyday_special.amount * holyDaysCount * qty),
        });
      }

      // The Total shown is always Pricing.computeLineTotal(...)'s own return
      // value, never a re-derived sum of the display lines above — those two
      // must be mathematically identical, but only one of them is the
      // fixture-tested function, so that's the one the customer sees.
      var total = Pricing.computeLineTotal({
        qty: qty,
        priceTable: priceTable,
        addonFees: addonFees,
        specialNumbering: hasSpecialNumbering(state),
        specialsCount: specialsCount,
        holyDaysCount: holyDaysCount,
      });

      linesEl.innerHTML = lines
        .map(function (l) {
          return (
            '<div class="lockie-configurator__lineitem"><span>' +
            escapeHtml(l.label) +
            "</span><span>" +
            totalFormatter.format(l.amount) +
            "</span></div>"
          );
        })
        .join("");
      totalEl.textContent = totalFormatter.format(total);
      unitNoteEl.textContent = "Unit price " + unitFormatter.format(unit) + " at " + qty + " sets.";
    }

    var state = {
      step: 0,
      qty: config.min_quantity || 1,
      box_colour: null,
      envelope_colour: null,
      text_colour: null,
      headings: {},
      verse: null,
      custom_verse: "",
      design: null,
      upload_name: "",
      num_from: "",
      num_to: "",
      excluded: "",
      specials: [],
      holydays: 0,
      start_date: "",
      notes: "",
    };

    // Locked single-value options are pre-set — nothing for the customer to pick.
    ["box_colour", "envelope_colour", "text_colour"].forEach(function (key) {
      var opt = config.steps.options && config.steps.options[key];
      if (opt && opt.locked && opt.values && opt.values.length) {
        state[key] = opt.values[0];
      }
    });

    var ctx = {
      config: config,
      priceTable: priceTable,
      addonFees: addonFees,
      state: state,
      refresh: refreshSummary,
      formatCurrency: function (n) { return totalFormatter.format(n); },
    };
    var steps = buildSteps(ctx);

    function buildStepper() {
      stepperEl.innerHTML = steps
        .map(function (st, i) {
          var cls = i === state.step ? "is-active" : i < state.step ? "is-done" : "";
          return (
            '<li class="' +
            cls +
            '"><span class="lockie-configurator__step-n">' +
            String(i + 1).padStart(2, "0") +
            "</span>" +
            escapeHtml(st.title) +
            "</li>"
          );
        })
        .join("");
    }

    function showStep() {
      stepsEl.innerHTML = "";
      var st = steps[state.step];
      var wrap = document.createElement("div");
      wrap.className = "lockie-configurator__step";
      wrap.innerHTML =
        "<h2>" +
        escapeHtml(st.title) +
        '</h2><p class="lockie-configurator__hint">' +
        escapeHtml(st.hint) +
        '</p><div class="lockie-configurator__step-body"></div>' +
        '<div class="lockie-configurator__err" id="lc-step-err"></div>' +
        '<div class="lockie-configurator__btns">' +
        '<button type="button" class="lockie-configurator__nav-btn lockie-configurator__nav-btn--ghost" id="lc-back"' +
        (state.step === 0 ? " disabled" : "") +
        ">Back</button>" +
        '<button type="button" class="lockie-configurator__nav-btn" id="lc-next">' +
        (state.step === steps.length - 1 ? "Finish" : "Next") +
        "</button>" +
        "</div>";
      stepsEl.appendChild(wrap);
      st.render(wrap.querySelector(".lockie-configurator__step-body"), ctx);

      wrap.querySelector("#lc-back").addEventListener("click", function () {
        if (state.step > 0) {
          state.step--;
          sync();
        }
      });
      wrap.querySelector("#lc-next").addEventListener("click", function () {
        var msg = st.validate(ctx);
        var errEl = wrap.querySelector("#lc-step-err");
        if (msg) {
          errEl.style.color = "";
          errEl.textContent = msg;
          return;
        }
        if (state.step < steps.length - 1) {
          state.step++;
          sync();
        } else {
          addCartEl.disabled = false;
          errEl.style.color = "var(--lc-green)";
          errEl.textContent = "All steps complete — you can add to basket.";
        }
      });

      buildStepper();
    }

    function sync() {
      showStep();
      refreshSummary();
    }

    addCartEl.addEventListener("click", function () {
      // Stage 3 wires the real /cart/add.js call. For now, just prove the
      // button is reachable once every step has validated cleanly.
      console.log("[lockie-configurator] block " + blockId + " ready to add to cart with state:", state);
    });

    sync();

    window.__lockieConfigurator = window.__lockieConfigurator || {};
    window.__lockieConfigurator[blockId] = { config: config, priceTable: priceTable, addonFees: addonFees, state: state };
  }

  document.querySelectorAll("[data-lockie-configurator]").forEach(createWizard);
})();
