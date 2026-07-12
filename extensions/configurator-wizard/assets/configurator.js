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
 *
 * Headings/verse/design UX pass: ported the real site's multi-mode dropdowns
 * (Enter new / Use previous for headings; popular / custom / previous / none
 * for verse and design) — see renderHeadings/renderDesign. Verse and design
 * stock lists now come from the custom.verses/custom.designs metafields
 * (readJSON'd in createWizard, same pattern as config/price_table/addon_fees)
 * rather than the old hardcoded arrays — see verse-catalogue.json/
 * design-catalogue.json at the repo root for the seed data and
 * scripts/setup-dev-store.mjs for how it's attached to each product.
 * "Use previous" never looks up order history — it's purely a flag for
 * fulfilment to action manually (see CLAUDE.md / the metafield schema notes).
 *
 * Stage 3: add-to-cart, in the addCartEl click handler in createWizard.
 * Always adds with quantity: 1 and carries the real box count via the
 * _quantity property — see CLAUDE.md's Hard rules for why (checkout rounds
 * fixedPricePerUnit to 2dp *before* multiplying by quantity, so any
 * quantity > 1 loses cent-exactness; pinning it at 1 lets the Function set
 * the full line total directly, no division). _special_numbering is read
 * straight off hasSpecialNumbering(state) — the same function the live £12
 * summary line uses — so the cart flag the Function trusts and the total
 * the customer saw can never disagree.
 *
 * Order-display pass: everything non-pricing-critical (colours, headings,
 * verse, design, numbering range, notes) is bundled into one
 * _display_fields_json property — same complexity-cap reason as before, one
 * attribute(key:) lookup instead of ~15 — but the Cart Transform Function
 * now parses and EXPLODES it into individually-labelled attributes on its
 * way out (see explodeDisplayFields in cart_transform_run.ts), so what
 * lands on the checkout/order is clean "Label: Value" rows matching the
 * WooCommerce layout, not a raw JSON blob. See buildDisplayFields.
 *
 * Uploads pass: the Design step's "Add a custom image" field and the
 * Holyday step's optional template upload both POST to the lockie-uploads
 * Cloudflare Worker (upload-worker/ at the repo root — see CLAUDE.md's
 * upload plan for why a Worker relay rather than a self-hosted backend or a
 * third-party app) on file-select, not deferred to add-to-basket. The
 * Worker's returned permanent URL lands in state (design_upload_url /
 * holyday_upload_url) and flows into buildDisplayFields exactly like every
 * other display field — no change to _quantity/pricing/Cart Transform,
 * uploads are display-only. See wireFileUpload/uploadFileToWorker.
 */
(function () {
  var WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  // Mirrors the mode dropdown option text in renderHeadings/renderDesign —
  // used to render the same wording into the "Heading"/"Verse"/"Design" rows
  // on the order (see buildDisplayFields).
  var HEADINGS_MODE_LABELS = { new: "Enter new heading", previous: "Use previous heading" };
  var VERSE_MODE_LABELS = {
    popular: "Select a popular verse",
    custom: "Add a custom verse",
    previous: "Use previous verse",
    none: "No verse",
  };
  var DESIGN_MODE_LABELS = {
    popular: "Select a popular design",
    custom: "Add a custom image",
    previous: "Use previous image",
    none: "No design",
  };

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

  // Compact "1-12, 14-53" representation of the numbering range minus valid
  // exclusions — the order's "Full Number Range" row. Contiguous runs are
  // collapsed rather than spelled out number-by-number: Weekly ranges run
  // into the hundreds, and Shopify line item property values have a
  // practical length limit, so a literal comma list risks truncation on
  // larger orders. Pure display formatting, not pricing — unlike
  // numberingMatch/hasSpecialNumbering, this doesn't need to live in
  // pricing.js.
  function formatNumberRange(fromRaw, toRaw, excludedStr) {
    var from = +fromRaw;
    var to = +toRaw;
    if (!fromRaw || !toRaw || isNaN(from) || isNaN(to) || to < from) return "";

    var excluded = {};
    (excludedStr || "").split(",").forEach(function (part) {
      var n = parseInt(part.trim(), 10);
      if (!isNaN(n) && n >= from && n <= to) excluded[n] = true;
    });

    var segments = [];
    var segStart = null;
    for (var n = from; n <= to + 1; n++) {
      var included = n <= to && !excluded[n];
      if (included) {
        if (segStart === null) segStart = n;
      } else if (segStart !== null) {
        segments.push(segStart === n - 1 ? String(segStart) : segStart + "-" + (n - 1));
        segStart = null;
      }
    }
    return segments.join(", ");
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

  /* ========================= UPLOADS ========================= */
  // Shared by the Design step's "Add a custom image" field and the Holyday
  // step's template upload — same Worker, same status states, different
  // state keys. See the file header's "Uploads pass" note.

  var UPLOAD_WORKER_URL = "https://lockie-uploads.lockiegroup.workers.dev/upload";
  var UPLOAD_MAX_SIZE = 20 * 1024 * 1024; // 20MB — mirrors upload-worker/src/index.ts
  var DESIGN_UPLOAD_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "ai"];
  var HOLYDAY_UPLOAD_EXTENSIONS = ["xlsx"];

  function uploadFileToWorker(file) {
    var formData = new FormData();
    formData.append("file", file);
    return fetch(UPLOAD_WORKER_URL, { method: "POST", body: formData }).then(function (res) {
      return res.text().then(function (text) {
        if (!res.ok) throw new Error(text || "Upload failed.");
        var body;
        try {
          body = JSON.parse(text);
        } catch (err) {
          throw new Error("Upload succeeded but the response was invalid.");
        }
        return body; // { url, filename }
      });
    });
  }

  // Wires a <input type="file"> to the upload Worker, tracking progress in
  // state[opts.statusKey] ("idle" | "uploading" | "done" | "error") and
  // rendering it into el's status element. Client-side type/size checks give
  // fast feedback before ever hitting the network; the Worker re-validates
  // both server-side regardless (never trust the client — same principle as
  // pricing, see CLAUDE.md).
  //
  // opts: { inputId, statusId, urlKey, filenameKey, statusKey, errorKey,
  //         allowedExtensions }
  function wireFileUpload(el, state, opts) {
    var input = el.querySelector("#" + opts.inputId);
    var statusEl = el.querySelector("#" + opts.statusId);
    if (!input || !statusEl) return;

    function renderStatus() {
      var status = state[opts.statusKey];
      if (status === "uploading") {
        statusEl.textContent = "Uploading…";
        statusEl.style.color = "";
      } else if (status === "done") {
        statusEl.textContent = "✓ Uploaded: " + state[opts.filenameKey];
        statusEl.style.color = "var(--lc-green)";
      } else if (status === "error") {
        statusEl.textContent = state[opts.errorKey] || "Upload failed.";
        statusEl.style.color = "var(--lc-accent)";
      } else {
        statusEl.textContent = "";
        statusEl.style.color = "";
      }
    }
    renderStatus();

    input.addEventListener("change", function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;

      var ext = (file.name.split(".").pop() || "").toLowerCase();
      if (opts.allowedExtensions && opts.allowedExtensions.indexOf(ext) === -1) {
        state[opts.statusKey] = "error";
        state[opts.errorKey] =
          "File type \"." + ext + "\" is not accepted. Allowed: " + opts.allowedExtensions.join(", ") + ".";
        renderStatus();
        return;
      }
      if (file.size > UPLOAD_MAX_SIZE) {
        state[opts.statusKey] = "error";
        state[opts.errorKey] =
          "File is too large (" + (file.size / 1024 / 1024).toFixed(1) + "MB) — max is 20MB.";
        renderStatus();
        return;
      }

      state[opts.statusKey] = "uploading";
      state[opts.urlKey] = "";
      state[opts.errorKey] = "";
      renderStatus();

      uploadFileToWorker(file)
        .then(function (result) {
          state[opts.statusKey] = "done";
          state[opts.urlKey] = result.url;
          state[opts.filenameKey] = result.filename;
          renderStatus();
        })
        .catch(function (err) {
          state[opts.statusKey] = "error";
          state[opts.errorKey] = err.message || "Upload failed.";
          renderStatus();
        });
    });
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
          if (!lines.length) return "";
          if (ctx.state.headings_mode === "new" && !ctx.state.headings[lines[0]]) {
            return "Please enter at least the " + lines[0] + ", or choose “Use previous heading”.";
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
        validate: function (ctx) {
          var s = ctx.state;
          var designConfig = ctx.config.steps.design.design;
          var uploadAllowed = ctx.config.uploads_enabled && designConfig && designConfig.allow_upload;
          if (uploadAllowed && s.design_mode === "custom") {
            if (s.design_upload_status === "uploading") {
              return "Please wait for your image to finish uploading.";
            }
            if (s.design_upload_status === "error") {
              return s.design_upload_error || "Please fix the upload error before continuing.";
            }
            if (s.design_upload_status !== "done" || !s.design_upload_url) {
              return "Please upload your custom image, or choose a different design option.";
            }
          }
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
        validate: function (ctx) {
          // Upload is optional (matches the live site) — only block while an
          // upload is actively in flight, so a customer can't click Next
          // mid-upload and lose the file silently.
          if (ctx.state.holyday_upload_status === "uploading") {
            return "Please wait for your template upload to finish.";
          }
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
    var mode = state.headings_mode || "new";

    var html =
      '<div class="lockie-configurator__field">' +
      '<label class="lockie-configurator__label">Heading</label>' +
      '<select id="lc-headings-mode">' +
      '<option value="new"' + (mode === "new" ? " selected" : "") + '>Enter new heading</option>' +
      '<option value="previous"' + (mode === "previous" ? " selected" : "") + '>Use previous heading</option>' +
      "</select>" +
      "</div>" +
      '<div id="lc-headings-fields" style="display:' + (mode === "new" ? "block" : "none") + '">' +
      lines
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
        .join("") +
      "</div>";

    el.innerHTML = html;

    el.querySelector("#lc-headings-mode").addEventListener("change", function (e) {
      state.headings_mode = e.target.value;
      el.querySelector("#lc-headings-fields").style.display = e.target.value === "new" ? "block" : "none";
    });
    el.querySelectorAll("input[data-h]").forEach(function (inp) {
      inp.addEventListener("input", function (e) {
        state.headings[e.target.dataset.h] = e.target.value;
      });
    });
  }

  // Shared by the verse and design mode-selects: builds the "mode" dropdown
  // plus whichever secondary control that mode needs, wires visibility, and
  // returns the wiring function so the caller can attach change/input
  // listeners once the whole step's HTML is in the DOM.
  //
  // opts: {
  //   idPrefix, label, modeKey (state key for the mode), modeOptions: [{value,text}],
  //   popularItems, popularValueKey (state key for the chosen popular code),
  //   popularOptionText: fn(item) -> string,
  //   customValueKey (state key for free-text custom value), customPlaceholder,
  //   customNote, chartUrl, chartLinkText (both optional — omit to skip the link)
  // }
  function renderModeField(state, opts) {
    var mode = state[opts.modeKey] || "none";
    var idPrefix = opts.idPrefix;

    var html =
      '<div class="lockie-configurator__field">' +
      '<div class="lockie-configurator__label-row">' +
      '<label class="lockie-configurator__label">' + escapeHtml(opts.label) + "</label>" +
      (opts.chartUrl
        ? '<a class="lockie-configurator__chart-link" href="' + escapeHtml(opts.chartUrl) +
          '" target="_blank" rel="noopener noreferrer">' + escapeHtml(opts.chartLinkText) + "</a>"
        : "") +
      "</div>" +
      '<select id="' + idPrefix + '-mode">' +
      opts.modeOptions
        .map(function (o) {
          return '<option value="' + o.value + '"' + (mode === o.value ? " selected" : "") + ">" + escapeHtml(o.text) + "</option>";
        })
        .join("") +
      "</select>";

    if (opts.popularItems) {
      html +=
        '<div class="lockie-configurator__field" id="' + idPrefix + '-popular-wrap" style="margin-top:10px;display:' +
        (mode === "popular" ? "block" : "none") +
        '">' +
        '<select id="' + idPrefix + '-popular">' +
        '<option value="">Choose…</option>' +
        opts.popularItems
          .map(function (item) {
            var v = item.code;
            return '<option value="' + escapeHtml(v) + '"' + (state[opts.popularValueKey] === v ? " selected" : "") + ">" +
              escapeHtml(opts.popularOptionText(item)) + "</option>";
          })
          .join("") +
        "</select>" +
        "</div>";
    }

    if (opts.customValueKey) {
      html +=
        '<div class="lockie-configurator__field" id="' + idPrefix + '-custom-wrap" style="margin-top:10px;display:' +
        (mode === "custom" ? "block" : "none") +
        '">';
      if (opts.fileUpload) {
        html +=
          '<input type="file" id="' + idPrefix + '-custom-file" accept="' + escapeHtml(opts.acceptAttr || "") + '">' +
          (opts.customNote ? '<div class="lockie-configurator__note">' + escapeHtml(opts.customNote) + "</div>" : "") +
          '<div class="lockie-configurator__note" id="' + idPrefix + '-custom-status"></div>';
      } else {
        html +=
          '<input type="text" id="' + idPrefix + '-custom" placeholder="' + escapeHtml(opts.customPlaceholder) + '" value="' +
          escapeHtml(state[opts.customValueKey]) +
          '">' +
          (opts.customNote ? '<div class="lockie-configurator__note">' + escapeHtml(opts.customNote) + "</div>" : "");
      }
      html += "</div>";
    }

    html += "</div>";
    return html;
  }

  function wireModeField(el, state, opts) {
    var modeSel = el.querySelector("#" + opts.idPrefix + "-mode");
    if (!modeSel) return;
    var popularWrap = el.querySelector("#" + opts.idPrefix + "-popular-wrap");
    var customWrap = el.querySelector("#" + opts.idPrefix + "-custom-wrap");

    modeSel.addEventListener("change", function (e) {
      state[opts.modeKey] = e.target.value;
      if (popularWrap) popularWrap.style.display = e.target.value === "popular" ? "block" : "none";
      if (customWrap) customWrap.style.display = e.target.value === "custom" ? "block" : "none";
    });

    var popularSel = el.querySelector("#" + opts.idPrefix + "-popular");
    if (popularSel) {
      popularSel.addEventListener("change", function (e) {
        state[opts.popularValueKey] = e.target.value;
      });
    }
    if (opts.fileUpload) {
      wireFileUpload(el, state, {
        inputId: opts.idPrefix + "-custom-file",
        statusId: opts.idPrefix + "-custom-status",
        urlKey: opts.urlKey,
        filenameKey: opts.filenameKey,
        statusKey: opts.statusKey,
        errorKey: opts.errorKey,
        allowedExtensions: opts.allowedExtensions,
      });
    } else {
      var customInp = el.querySelector("#" + opts.idPrefix + "-custom");
      if (customInp) {
        customInp.addEventListener("input", function (e) {
          state[opts.customValueKey] = e.target.value;
        });
      }
    }
  }

  function renderDesign(el, ctx) {
    var config = ctx.config;
    var state = ctx.state;
    var designConfig = config.steps.design;
    var verseEnabled = designConfig.verse && designConfig.verse.enabled;
    var verseAllowCustom = designConfig.verse && designConfig.verse.allow_custom;
    var designEnabled = designConfig.design && designConfig.design.enabled;
    var uploadAllowed = config.uploads_enabled && designConfig.design && designConfig.design.allow_upload;
    var verses = ctx.verses || [];
    var designs = ctx.designs || [];
    var chartUrls = ctx.chartUrls || {};

    var verseModeOptions = [];
    if (verses.length) verseModeOptions.push({ value: "popular", text: "Select a popular verse" });
    if (verseAllowCustom) verseModeOptions.push({ value: "custom", text: "Add a custom verse" });
    verseModeOptions.push({ value: "previous", text: "Use previous verse" }, { value: "none", text: "No verse" });

    var designModeOptions = [];
    if (designs.length) designModeOptions.push({ value: "popular", text: "Select a popular design" });
    if (uploadAllowed) designModeOptions.push({ value: "custom", text: "Add a custom image" });
    designModeOptions.push({ value: "previous", text: "Use previous image" }, { value: "none", text: "No design" });

    var html = "";

    if (verseEnabled) {
      html += renderModeField(state, {
        idPrefix: "lc-verse",
        label: "Verse",
        modeKey: "verse_mode",
        modeOptions: verseModeOptions,
        popularItems: verses.length ? verses : null,
        popularValueKey: "verse_code",
        popularOptionText: function (v) { return v.code + " — " + v.text; },
        customValueKey: verseAllowCustom ? "custom_verse" : null,
        customPlaceholder: "Type your custom verse",
        chartUrl: chartUrls.verses || null,
        chartLinkText: "View verses chart",
      });
    }

    if (designEnabled) {
      html += renderModeField(state, {
        idPrefix: "lc-design",
        label: "Design",
        modeKey: "design_mode",
        modeOptions: designModeOptions,
        popularItems: designs.length ? designs : null,
        popularValueKey: "design_code",
        popularOptionText: function (d) { return d.code + " — " + d.description; },
        customValueKey: uploadAllowed ? "design_upload_url" : null,
        fileUpload: uploadAllowed,
        acceptAttr: "." + DESIGN_UPLOAD_EXTENSIONS.join(",."),
        urlKey: "design_upload_url",
        filenameKey: "design_upload_filename",
        statusKey: "design_upload_status",
        errorKey: "design_upload_error",
        allowedExtensions: DESIGN_UPLOAD_EXTENSIONS,
        customNote: uploadAllowed ? "Accepted: pdf, png, ai, jpg — max 20MB." : null,
        chartUrl: chartUrls.designs || null,
        chartLinkText: "View designs chart",
      });
    }

    el.innerHTML = html;

    if (verseEnabled) {
      wireModeField(el, state, {
        idPrefix: "lc-verse",
        modeKey: "verse_mode",
        popularValueKey: "verse_code",
        customValueKey: verseAllowCustom ? "custom_verse" : null,
      });
    }
    if (designEnabled) {
      wireModeField(el, state, {
        idPrefix: "lc-design",
        modeKey: "design_mode",
        popularValueKey: "design_code",
        customValueKey: uploadAllowed ? "design_upload_url" : null,
        fileUpload: uploadAllowed,
        urlKey: "design_upload_url",
        filenameKey: "design_upload_filename",
        statusKey: "design_upload_status",
        errorKey: "design_upload_error",
        allowedExtensions: DESIGN_UPLOAD_EXTENSIONS,
      });
    }
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
    var chartUrl = (ctx.chartUrls || {}).holydays;
    var showUpload = state.holydays > 0;

    var opts = '<option value="0">No holyday specials</option>';
    for (var i = 1; i <= max; i++) {
      opts += '<option value="' + i + '"' + (state.holydays === i ? " selected" : "") + ">+" + i + " special" + (i > 1 ? "s" : "") + "</option>";
    }
    el.innerHTML =
      '<div class="lockie-configurator__field">' +
      '<label class="lockie-configurator__label">Number of holyday specials</label>' +
      '<select id="lc-hd">' + opts + "</select>" +
      "</div>" +
      '<div class="lockie-configurator__field" id="lc-hd-upload-wrap" style="display:' + (showUpload ? "block" : "none") + '">' +
      (chartUrl
        ? '<div class="lockie-configurator__note"><a class="lockie-configurator__chart-link" href="' +
          escapeHtml(chartUrl) +
          '" target="_blank" rel="noopener noreferrer">Click here to download our Holydays template list for upload</a></div>'
        : "") +
      '<label class="lockie-configurator__label">Upload your filled-in template (optional)</label>' +
      '<input type="file" id="lc-hd-file" accept="' + escapeHtml("." + HOLYDAY_UPLOAD_EXTENSIONS.join(",.")) + '">' +
      '<div class="lockie-configurator__note" id="lc-hd-file-status"></div>' +
      "</div>";

    el.querySelector("#lc-hd").addEventListener("change", function (e) {
      state.holydays = +e.target.value;
      el.querySelector("#lc-hd-upload-wrap").style.display = state.holydays > 0 ? "block" : "none";
      ctx.refresh();
    });

    wireFileUpload(el, state, {
      inputId: "lc-hd-file",
      statusId: "lc-hd-file-status",
      urlKey: "holyday_upload_url",
      filenameKey: "holyday_upload_filename",
      statusKey: "holyday_upload_status",
      errorKey: "holyday_upload_error",
      allowedExtensions: HOLYDAY_UPLOAD_EXTENSIONS,
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
    var verses = readJSON(root.dataset.versesId) || [];
    var designs = readJSON(root.dataset.designsId) || [];
    var chartUrls = readJSON(root.dataset.chartUrlsId) || {};
    var variantId = root.dataset.variantId;

    if (!config || !config.steps) {
      console.error("[lockie-configurator] block " + blockId + " has no usable config metafield — nothing to render.");
      return;
    }

    var stepperEl = document.getElementById("lockie-configurator-stepper-" + blockId);
    var stepsEl = document.getElementById("lockie-configurator-steps-" + blockId);
    var addCartEl = document.getElementById("lockie-configurator-addcart-" + blockId);
    var addCartErrEl = document.getElementById("lockie-configurator-addcart-err-" + blockId);
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
      headings_mode: "new",
      verse_mode: "none",
      verse_code: "",
      custom_verse: "",
      design_mode: "none",
      design_code: "",
      design_upload_url: "",
      design_upload_filename: "",
      design_upload_status: "idle",
      design_upload_error: "",
      num_from: "",
      num_to: "",
      excluded: "",
      specials: [],
      holydays: 0,
      holyday_upload_url: "",
      holyday_upload_filename: "",
      holyday_upload_status: "idle",
      holyday_upload_error: "",
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
      verses: verses,
      chartUrls: chartUrls,
      designs: designs,
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

    // Re-checks every step, not just the current one — the Finish click that
    // enables the button only validated the *last* step reached. A customer
    // can hit Back afterwards and break an earlier step (e.g. widen the
    // numbering range out of match) without the button ever re-disabling, so
    // this is the actual gate on what reaches checkout.
    function validateAllSteps() {
      for (var i = 0; i < steps.length; i++) {
        var msg = steps[i].validate(ctx);
        if (msg) return { index: i, message: msg };
      }
      return null;
    }

    // Looks up a popular verse/design's resolved display text ("V3 — The
    // Lord blesses...", "C1 — Praying hands") from the code the customer
    // picked. Returns "" for previous/none modes (nothing to show) or a
    // custom mode's own free text — see buildDisplayFields.
    function resolveSelectedVerse() {
      if (state.verse_mode === "custom") return state.custom_verse || "";
      if (state.verse_mode !== "popular") return "";
      var match = verses.filter(function (v) { return v.code === state.verse_code; })[0];
      return match ? match.code + " — " + match.text : "";
    }

    function resolveSelectedDesign() {
      if (state.design_mode === "custom") {
        return state.design_upload_status === "done" ? state.design_upload_url : "";
      }
      if (state.design_mode !== "popular") return "";
      var match = designs.filter(function (d) { return d.code === state.design_code; })[0];
      return match ? match.code + " — " + match.description : "";
    }

    // Builds the ordered [label, value] pairs that become the customer/office
    // -visible rows on the checkout/order — mirrors the WooCommerce layout
    // (Quantity, Box Colour, Envelope Colour, Text Colour, Heading, per-line
    // heading values, Verse, Selected Verse, Design, Selected Design,
    // Numbered from/to, Excluded Numbers, Full Number Range, Holyday
    // specials, Specials, Start Date, Notes). Array order here is exactly
    // the order the Function will emit the exploded attributes in — see
    // explodeDisplayFields in cart_transform_run.ts.
    function buildDisplayFields() {
      var fields = [];
      function push(label, value) {
        if (value !== null && value !== undefined && value !== "") fields.push([label, value]);
      }

      push("Quantity", String(state.qty));
      push("Box Colour", state.box_colour);
      push("Envelope Colour", state.envelope_colour);
      push("Text Colour", state.text_colour);

      push("Heading", HEADINGS_MODE_LABELS[state.headings_mode] || state.headings_mode);
      if (state.headings_mode === "new") {
        (config.steps.headings.lines || []).forEach(function (line) {
          push(line, state.headings[line]);
        });
      }

      push("Verse", VERSE_MODE_LABELS[state.verse_mode] || state.verse_mode);
      push("Selected Verse", resolveSelectedVerse());
      push("Design", DESIGN_MODE_LABELS[state.design_mode] || state.design_mode);
      push("Selected Design", resolveSelectedDesign());

      push("Numbered from", state.num_from);
      push("Numbered to", state.num_to);
      fields.push(["Excluded Numbers", state.excluded || "None"]);
      push("Full Number Range", formatNumberRange(state.num_from, state.num_to, state.excluded));

      fields.push(["Holyday specials", state.holydays > 0 ? String(state.holydays) : "None"]);
      push("Holyday Template", state.holyday_upload_status === "done" ? state.holyday_upload_url : "");
      push("Specials", state.specials.join(", "));

      push("Start Date", state.start_date);
      push("Notes", state.notes);

      return fields;
    }

    // Stage 3 cart payload — see CLAUDE.md "Line item properties written on
    // add-to-basket" and metafield-schema.md for the shape this mirrors.
    // Pricing-critical properties are sent individually because they're what
    // cart_transform_run.graphql queries by name; _special_numbering must be
    // "yes"/"no" (the Function checks `=== "yes"` literally) and comes from
    // hasSpecialNumbering(state) — the exact function the live £12 summary
    // line uses, so the two can never disagree.
    //
    // Everything else — the WooCommerce-style display rows plus the
    // calc_unit_price/calc_line_total audit values — is bundled into one
    // _display_fields_json attribute (still just one query-complexity unit
    // for the Function to fetch) as { display: [...], audit: [...] }
    // label/value pairs. The Function explodes `display` into visible
    // attributes and `audit` back into `_`-prefixed hidden ones on its way
    // onto the final order — see explodeDisplayFields in
    // cart_transform_run.ts. This is why the office sees clean labelled rows
    // instead of a raw JSON blob without the Function's input query ever
    // exceeding its 30-point complexity cap.
    function buildCartProperties() {
      var Pricing = window.LockieConfiguratorPricing;
      var qty = state.qty;
      var unit = Pricing.findUnitPrice(priceTable.bands, qty);
      var lineTotal = Pricing.computeLineTotal({
        qty: qty,
        priceTable: priceTable,
        addonFees: addonFees,
        specialNumbering: hasSpecialNumbering(state),
        specialsCount: state.specials.length,
        holyDaysCount: state.holydays,
      });

      var displayFieldsJson = {
        display: buildDisplayFields(),
        audit: [
          ["calc_unit_price", unit],
          ["calc_line_total", lineTotal],
        ],
      };

      return {
        _quantity: String(qty),
        _special_numbering: hasSpecialNumbering(state) ? "yes" : "no",
        _specials: state.specials.join(","),
        _holydays_count: String(state.holydays),
        _display_fields_json: JSON.stringify(displayFieldsJson),
      };
    }

    addCartEl.addEventListener("click", function () {
      if (addCartErrEl) addCartErrEl.textContent = "";

      var invalid = validateAllSteps();
      if (invalid) {
        state.step = invalid.index;
        sync();
        var errEl = stepsEl.querySelector("#lc-step-err");
        if (errEl) errEl.textContent = invalid.message;
        return;
      }

      if (!variantId) {
        if (addCartErrEl) addCartErrEl.textContent = "This product has no purchasable variant — contact support.";
        return;
      }

      var properties;
      try {
        properties = buildCartProperties();
      } catch (err) {
        if (addCartErrEl) addCartErrEl.textContent = "Could not price this configuration — check the quantity and try again.";
        return;
      }

      var originalLabel = addCartEl.textContent;
      addCartEl.disabled = true;
      addCartEl.textContent = "Adding…";

      // quantity is always 1 here — the customer's real box count travels as
      // the _quantity property instead. See CLAUDE.md's Hard rules: the Cart
      // Transform Function needs the parent line's own quantity pinned at 1
      // for the exact-to-the-penny fixedPricePerUnit override to work; if
      // this ever adds with quantity > 1, the Function still prices it, just
      // not cent-exact.
      fetch("/cart/add.js", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          id: Number(variantId),
          quantity: 1,
          properties: properties,
        }),
      })
        .then(function (res) {
          return res.json().then(function (body) {
            if (!res.ok) throw new Error(body.description || body.message || "Could not add to basket.");
            return body;
          });
        })
        .then(function () {
          window.location.href = "/checkout";
        })
        .catch(function (err) {
          addCartEl.disabled = false;
          addCartEl.textContent = originalLabel;
          if (addCartErrEl) addCartErrEl.textContent = err.message || "Could not add to basket. Please try again.";
        });
    });

    sync();

    window.__lockieConfigurator = window.__lockieConfigurator || {};
    window.__lockieConfigurator[blockId] = { config: config, priceTable: priceTable, addonFees: addonFees, verses: verses, designs: designs, chartUrls: chartUrls, state: state };
  }

  document.querySelectorAll("[data-lockie-configurator]").forEach(createWizard);
})();
