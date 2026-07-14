# CLAUDE.md — Lockie Church Configurator (Shopify)

Project brief for Claude Code. Read this fully before writing or changing code.
Keep it current: when an architectural decision is made or reversed, update this file.

## What this project is

A custom product configurator for **lockiechurch.com**, migrating from
WooCommerce to Shopify. Lockie sells custom-printed church collection envelopes.
The flagship products are configured through a multi-step wizard with banded
quantity pricing, custom print options, file uploads, numbering, and add-on fees.

Customers **pay online** (self-serve checkout). This is the single most important
constraint: it means the configured price must be enforced **server-side**, because
Shopify does not let front-end JavaScript set the charged price.

## Architecture (do not deviate without updating this file)

Four layers:

1. **Data — product metafields (JSON).** Each configurable product carries
   `custom.config`, `custom.price_table`, `custom.addon_fees`. Options, pricing,
   and rules live here, not in code. See `metafield-schema.md`.
2. **Front end — theme app extension.** One wizard block reads the metafields and
   renders the steps. Layout is data, not code. The reference implementation of the
   flow and pricing UX is `weekly-configurator.html` (a standalone prototype — port
   its logic, not its standalone form).
3. **Price enforcement — Cart Transform Function.** Recomputes the line price
   server-side from `price_table` + `addon_fees`. **This is the source of truth for
   what is charged.** The front end's number is display-only and must never be trusted.
4. **Uploads — file-upload mechanism.** Customer uploads design / holyday files
   before checkout; the file URL is attached to the order as a line item property.

## The product tiers

- **Tier 1 — native Shopify products, no configurator.** e.g. Treasurer Cash Books:
  quantity × fixed unit price, no options. No `custom.config` metafield. Do not build
  a wizard for these.
- **Tier 2 — full configurator.** e.g. Weekly Boxed Sets: all steps, multi-value
  options, uploads, numbering, holydays, 40-band price table. This is the maximal case
  and the one we build first.
- **Tier 3 — configurator with locked options.** e.g. Economy: same wizard, but
  options have a single locked value, uploads disabled, simpler price table. **No new
  code — just different metafield JSON.** Proving Economy works by config alone is the
  validation that the data-driven design holds.

Rule for classifying a product: any custom free-text, upload, numbering, or banded
price → Tier 2/3 wizard. Otherwise → Tier 1 native variant.

## Build order (follow this sequence)

1. Scaffold app: `shopify app init`, then generate `cart_transform` and
   `theme_app_extension` extensions. ✅ done.
2. Create metafield definitions on the dev store from `metafield-schema.md`
   (write a setup script). Attach the Weekly `price_table` from
   `price-table-weekly.json`. ✅ done.
3. **Spike the Cart Transform Function in isolation first.** Prove that a cart line
   for 52 Weekly sets + special numbering charges exactly £163.32 at the dev store
   checkout, recomputed server-side. Do this BEFORE building any UI.
   ✅ **DONE and verified end-to-end** — see "Cart Transform spike — proven" below.
4. Prove Tier 3 (Economy) prices correctly by config alone, using the same
   AJAX-only spike method as step 3 (new product + its own `price_table`/
   `addon_fees` metafields, no wizard needed yet) — validates the data-driven
   design cheaply before investing in the wizard build.
   ✅ **DONE and verified end-to-end** — see "Tier 3 (Economy) spike — proven"
   below. Full options-locking behaviour still needs the wizard UI to actually
   verify (step 8).
5. Build the theme app extension wizard, porting the logic from
   `weekly-configurator.html`, reading the metafields. Must add-to-cart with
   `quantity: 1` and write `_quantity` — see Hard rules.
   ✅ **DONE** — Stage 0–2 (rendering/validation, live pricing), the
   headings/verse/design UX pass, and Stage 3 (`/cart/add.js` + redirect to
   checkout) all landed and are verified end-to-end — see "Stage 3 — proven"
   below.
6. Wire uploads; confirm the file URL survives onto the paid order.
   ✅ **DONE and verified end-to-end** — see "Uploads — proven" below. Two
   approaches were assessed and rejected before landing on the front-runner,
   which is what got built:
   - ❌ *Self-hosted App Proxy → `stagedUploadsCreate`/`fileCreate` → Shopify
     Files.* Rejected: needs an always-on production backend, which doesn't
     exist. `application_url` in both `shopify.app*.toml` is still the
     scaffold placeholder `https://example.com` — today the app only runs
     via `shopify app dev`'s local process + Cloudflare tunnel on a dev
     machine. The Cart Transform Function and theme extension never needed a
     live backend (they run inside Shopify / are static respectively), so
     this gap was invisible until uploads. Not pursuing this without
     committing to real hosting (Fly.io/Render/Railway/VPS) first.
   - ❌ *Third-party upload app (Uploadery/UploadKit/Upload-Lift etc.).*
     Rejected: doesn't cleanly fit this wizard. These apps bind to either a
     native `<form action="/cart/add">` (Uploadery — `form[data-uploadery]`)
     or ship as their own independent Online Store 2.0 app block
     (UploadKit/Upload-Lift). Our wizard has neither: `configurator.liquid`
     has no `<form>`, add-to-cart is a plain `fetch("/cart/add.js", ...)` at
     the end of the flow (`configurator.js`), and one app's theme-extension
     block can't render inside another app's block — so their widget would
     land as a separate page element, unable to be scoped to "only show
     when design_mode is custom" or gate our own Next/Add-to-basket buttons.
     Uploadery's `uploadSuccess` JS event might allow a headless-style
     integration, but that's unconfirmed against vendor docs and still adds
     a recurring cost and a third-party storage dependency for customer
     artwork.
   - ❌ *Easify Product Options (free, works well on another of the site
     owner's stores).* Rejected: same architectural mismatch — it installs
     as a theme App Embed hooking the native product form, and its docs
     (132 pages) never mention a JS API/event for reading the uploaded
     file's URL from custom code, less documented headless surface than
     Uploadery even had. Free plan does include file upload, but uploaded
     files **auto-delete after 90 days** — a second, independent
     disqualifier for print-fulfilment artwork regardless of integration
     fit. Works well on the owner's other store because that store uses an
     unmodified native product form — exactly Easify's target case, not
     ours.
   - ✅ **Built: a minimal serverless upload relay** — `upload-worker/`, a
     Cloudflare Worker + private R2 bucket (`lockie-uploads`), deployed and
     proven both in isolation and now through the real wizard UI. The Design
     step's "Add a custom image" mode and the Holyday step's optional
     template upload both POST to it on file-select and get back a permanent
     `/file/:key` URL, which lands in `_display_fields_json` alongside every
     other field — exactly the shape planned here, no always-on app backend
     needed.
   - The "interim launch fallback" (email artwork, no real uploads) that was
     tracked here while this was deferred is no longer needed — uploads are
     live.
7. Full end-to-end test on the dev store: configure → live total → checkout → paid
   order shows correct charge + all line item properties + file.
   ✅ **DONE for Weekly, including the file** — real order #1001 placed via
   the actual wizard UI proved the total + labelled breakdown; order #1003
   (see "Uploads — proven" below) proved the same flow with real uploaded
   files attached, both surviving onto the paid order as clickable URLs.
8. Confirm Tier 3 (Economy) end-to-end through the actual wizard (options
   correctly locked, simpler price table) — no code changes, config only.
   ✅ **DONE** — real paid order #1002, placed through the actual wizard UI
   against Economy Boxed Sets, charged exactly **£110.28**. Same zero-code-change
   proof as the earlier AJAX spike, now through the real UI: Step 8 is complete
   for both tiers.
9. Build the remaining Tier 2/3 configurator products (LBS, MES, BKS as
   config, same pattern as Economy; assess LP separately — see "Product
   catalogue classification" below). ✅ **DONE for LBS/MES/BKS** — see "LBS
   spike — proven" / "MES spike — proven" / "BKS spike — proven" below. LP
   (Customisable Gift Aid Envelopes) is the only configurator product left,
   and it's a different shape (see "Product catalogue classification") — not
   a drop-in like these three. Full wizard-UI end-to-end (not just the AJAX
   spike) is still outstanding for all three, same as Weekly/Economy's own
   step 7/8 pass.
10. Catalogue / customer / order migration (Matrixify) + 301 redirects run separately.

### Cart Transform spike — proven

Confirmed live on `lockie-church.myshopify.com` (a non-Plus "Grow" plan dev
store) via `/cart/add.js` + real checkout, no theme/wizard UI involved:

- 52 Weekly Boxed Sets + special numbering + 2 specials (Christmas, Easter)
  charges **exactly £163.32** at checkout, recomputed server-side by the
  `pricing-function` Cart Transform.
- `lineExpand` (not `lineUpdate`) is the correct mechanism for a non-Plus
  production store — confirmed via a live `update_feature_not_available`
  rejection on `lineUpdate`, and `lineExpand` working cleanly in its place.
- All `_`-prefixed line item properties survive onto the transformed line via
  explicit `ExpandedItem.attributes` passthrough (`_quantity`,
  `_special_numbering`, `_specials`, plus `_config_json` for everything else).
- Exact-to-the-penny totals require add-to-cart with `quantity: 1` and the
  real box count carried via `_quantity` — see Hard rules for why.
- Three real bugs were found and fixed along the way (all documented in Hard
  rules below): the Plus-only restriction on `lineUpdate`, `ExpandedItem`
  quantity squaring the total, and per-unit rounding drift on quantities > 1.

Remaining open item from this spike: confirm production (lockiechurch.com)'s
actual currency is GBP before go-live. Update: the dev store now displays and
charges in GBP (£163.32 confirmed at checkout and on the paid order in the
Stage 3 end-to-end test below), so the wizard/Function pricing math is
validated in the right currency — still worth a final sanity check that the
production store's own currency/presentment settings match before go-live.

### Tier 3 (Economy) spike — proven

Confirmed live on the same dev store, same AJAX-only method (`/cart/add.js` +
real checkout, no wizard UI) — new "Economy Boxed Sets" product seeded via the
generalized `scripts/setup-dev-store.mjs` (now loops over a `PRODUCTS` list
instead of hardcoding Weekly) with its own `custom.price_table`/`custom.addon_fees`:

- 52 Economy sets + special numbering + 2 specials (Christmas, Easter) charges
  **exactly $110.28** at checkout — `round2(1.83×52)=95.16 + 12.00 + 0.03×2×52=3.12`.
- Same deployed `pricing-function` Cart Transform, **zero code changes** — it
  priced a second product correctly purely because the Function reads
  `price_table`/`addon_fees` from `merchandise.product.metafield(...)` on
  whichever variant is in the cart, not from anything hardcoded to Weekly.
- Different band (£1.83 vs Weekly's per-band rates) and different fee
  (`extra_envelope` £0.03 vs Weekly's £0.05) both applied correctly, proving the
  Function is genuinely generic across per-product metafield values, not just
  reusing Weekly's numbers by coincidence.
- Confirms the data-driven design from `metafield-schema.md`: layout and
  pricing rules are JSON, not code — Tier 2/Tier 3 differ only in what's in the
  metafields.

The qty-24 anomaly (Economy priced £2.70 in old WooCommerce data vs. £2.78 on
either side) was resolved as **legacy noise**, not a deliberate break — seeded
as one flat 20–39 band at £2.78. See Hard rules below.

### Stage 3 — proven

Confirmed live on the dev store, this time through the actual wizard UI (not
an AJAX spike) — configured Weekly Boxed Sets end-to-end and placed a real
paid test order (#1001):

- Wizard configured with qty 52, verse V18, design D1, numbering range with
  exclusions producing "Full Number Range" `1-12, 14-53`, 2 specials
  (Christmas, Easter) — "Add to basket" → `/cart/add.js` with `quantity: 1`
  and the real box count in `_quantity` → redirect to `/checkout`.
- Checkout charged **exactly £163.32**, recomputed server-side by the
  Function from the same 4 hidden pricing attributes as the earlier AJAX
  spike — proves the wizard's real add-to-cart call reproduces the spike's
  proven pricing path exactly, not just in theory.
- Checkout also displayed the full clean labelled breakdown (Quantity,
  colours, Verse, Selected Verse, Design, Selected Design, Full Number Range,
  Specials, etc.) to the customer, in GBP.
- The paid order in Shopify admin shows the same clean labelled rows for
  fulfilment, plus the hidden audit properties (`_quantity`,
  `_special_numbering`, `_specials`, `_holydays_count`, `_calc_unit_price`,
  `_calc_line_total`) — confirms `explodeDisplayFields` in
  `cart_transform_run.ts` correctly explodes `_display_fields_json` into
  individually-keyed order attributes without the Function's input query
  exceeding its 30-point complexity cap.
- This is the first proof of the whole chain running through the real UI a
  customer will use, not a manual `/cart/add.js` spike — wizard → cart →
  Cart Transform → checkout → paid order, all matching.

### Uploads — proven

Confirmed live on the dev store through the actual wizard UI — real paid test
order (#1003) placed against Weekly Boxed Sets with both upload points used:

- Design step's "Add a custom image" mode: uploaded a file, "Selected
  Design" on checkout and on the paid order shows a real
  `lockie-uploads.lockiegroup.workers.dev/file/...` URL (not the Stage 3
  stub), and clicking it downloads the uploaded file.
- Holyday step's optional template upload: a "Holyday Template" row appears
  on the same order with its own Worker URL, same click-to-download
  behaviour.
- Price stayed exact (£79.67, clean numbering range so `_special_numbering:
  no`) — confirms uploads are genuinely display-only and don't perturb the
  Cart Transform pricing path.
- First real proof of the whole uploads chain: browser file picker → Worker
  `/upload` (validate, store in R2) → permanent `/file/:key` URL → wizard
  state → `_display_fields_json` → exploded onto the paid order — not just
  the Worker tested in isolation.

### LBS spike — proven

Confirmed live on the dev store, same AJAX-only method as the Weekly/Economy
spikes (`/cart/add.js` + real checkout, no wizard UI) — new "Large Weekly
Boxed Sets" product seeded via `scripts/setup-dev-store.mjs` (now a third
entry in `PRODUCTS`) with its own `custom.price_table`/`custom.addon_fees`/
`custom.config`, built from the site owner's 2025 catalogue price-break list
(30 breaks, 30→350+ sets):

- Qty 60 + special numbering + 2 specials (Christmas, Easter) charges
  **exactly £236.97** at checkout — `round2(3.6495×60)=218.97 + 12.00 +
  0.05×2×60=6.00` — recomputed server-side by the same deployed
  `pricing-function` Cart Transform, **zero code changes**, third product
  proven generic.
- Price table was derived differently from Weekly/Economy's WooCommerce row
  exports: the site owner gave 30 discrete price *breaks* (quantity → total),
  not per-row units. Each band's `unit` rate is `break_total ÷ break_qty`
  (11 decimal places — enough for every breakpoint to round-trip to the exact
  penny, verified by script before writing the file), with `to` running up to
  one below the next break's quantity. The last band (350+) is open-ended
  (`to: 999999`) — confirmed with the site owner there's no further real
  breakpoint above 350, so any larger order still prices at that rate rather
  than throwing `"No price band covers quantity"`.
- `min_quantity: 30` (vs Weekly's 20) and box/envelope colours (Blue/Yellow;
  Blue/Yellow/White) differ from Weekly, but `holydays.max: 60`,
  `printed_extra` (£0.01), and `holyday_special` (£0.05) were confirmed by
  the site owner to intentionally match Weekly exactly — Large Weekly is the
  same product family (weekly cadence, same fee structure), just larger
  envelopes and its own price table.
- 4 new shared fixtures added to `pricing-fixtures.json` (exact breakpoint,
  mid-band interpolation, the open-ended last band, and an addons case) and
  wired into both `extensions/pricing-function/tests/pricing.test.ts` and
  `wizard-pricing-tests/tests/pricing.test.js` — all pass, confirming the
  Function's and the wizard's pricing implementations agree on LBS exactly
  the same way they already agreed on Weekly/Economy.
- The product had to be switched from the setup script's default `DRAFT`
  status to **Active** with the **Online Store** sales channel enabled by
  hand in Shopify admin before `/cart/add.js` would accept it — the setup
  script only creates/updates the product and metafields, it never publishes.

Remaining for LBS: full wizard-UI end-to-end (build order step 7/8 style,
real paid test order) — not yet done, only the AJAX spike is proven so far.
MES and BKS still need their own price/config data and the same spike.

### MES spike — proven

Confirmed live on the dev store, same AJAX-only method as LBS — new "Monthly
Envelope Boxed Sets" product seeded via `scripts/setup-dev-store.mjs` (now a
fourth entry in `PRODUCTS`) with its own `custom.price_table`/
`custom.config`, built from the site owner's 2025 catalogue price-break list
(only 4 breaks — a much simpler table than Weekly/LBS):

- Qty 60 + special numbering + 2 specials (Christmas, Easter) charges
  **exactly £115.64** at checkout — `round2(1.6274×60)=97.64 + 12.00 +
  0.05×2×60=6.00` — same deployed `pricing-function` Cart Transform, zero
  code changes, fourth product proven generic.
- Same break→rate derivation as LBS (`unit = break_total ÷ break_qty`, 11dp,
  each of the 4 breakpoints round-trips to the exact penny), open-ended last
  band above the 100-set break (`to: 999999`).
- `min_quantity: 25`, box colour Blue/Green, envelope colour Blue/Yellow/
  Green/Manilla/White — all differ from Weekly/LBS. `addon_fees` and
  `holydays.max: 60` were confirmed by the site owner to match Weekly
  exactly (Monthly's own catalogue independently states the same £12
  special-numbering charge) — same "same product family, different price
  table" reasoning as LBS.
- 4 new shared fixtures added to `pricing-fixtures.json`, wired into both
  test suites — all pass (22 Function tests, 29 wizard tests total across
  all four tiers).
- Same manual-publish step as LBS: setup script leaves the product `DRAFT`,
  had to be set Active + Online Store by hand before `/cart/add.js` worked.

Remaining for MES: full wizard-UI end-to-end, same as LBS. BKS is next —
same pattern, awaiting its own price/config data from the site owner.

### BKS spike — proven

Confirmed live on the dev store, same AJAX-only method as LBS/MES — new
"Booklet Envelope Sets" product seeded via `scripts/setup-dev-store.mjs`
(now a fifth entry in `PRODUCTS`) with its own `custom.price_table`/
`custom.config`, built from the site owner's 2025 catalogue price-break list
(28 breaks, 25→300+ sets):

- Qty 62 + special numbering + 2 specials (Christmas, Easter) charges
  **exactly £129.41** at checkout — `round2(1.79366666667×62)=111.21 +
  12.00 + 0.05×2×62=6.20` — same deployed `pricing-function` Cart Transform,
  zero code changes, fifth product proven generic.
- Same break→rate derivation as LBS/MES (`unit = break_total ÷ break_qty`,
  11dp, all 28 breakpoints round-trip to the exact penny), open-ended last
  band above the 300-set break (`to: 999999`).
- **Shape variation, not just data**: a booklet has no box, so `box_colour`
  is omitted from `CONFIG_BKS.steps.options` entirely (not locked to a
  single value like Economy's colours — genuinely absent). Confirmed via
  reading `configurator.js` before building this that the wizard already
  handles a missing option key cleanly: `renderOptions`'s field loop does
  `if (!opt) return;` per field, the options-step validator only checks
  `opts.box_colour` when that key exists, and `buildDisplayFields`'s `push()`
  helper skips null/undefined values — so "Box Colour" simply never appears
  as a rendered field, a validation requirement, or an order row. **Zero
  code changes** — the first real proof that the config schema's optionality
  (not just its values) is genuinely data-driven, not merely a convenient
  coincidence of the three products before it always having all three
  colour options.
- `min_quantity: 25`, envelope colour Blue/Yellow/Green/Pink/White — Weekly
  colours differ as expected. `addon_fees` and `holydays.max: 60` confirmed
  by the site owner to match Weekly exactly, same as LBS/MES — the catalogue
  independently confirms the same £12 special-numbering charge and notes
  booklet supports numbering range + exclusions + non-sequential numbering.
- 4 new shared fixtures added to `pricing-fixtures.json`, wired into both
  test suites — all pass (26 Function tests, 33 wizard tests total across
  all five tiers).
- Same manual-publish step as LBS/MES: setup script leaves the product
  `DRAFT`, had to be set Active + Online Store by hand before `/cart/add.js`
  worked.

**All three remaining boxed-set configurators (LBS, MES, BKS) are now
proven config-only builds, zero code changes** — Build Order step 9 is
complete for them. LP (Customisable Gift Aid Envelopes) is the only
configurator product left before the Matrixify migration (step 10) can
start in earnest, and per "Product catalogue classification" below it's a
different shape (envelope colour, Gift Aid declaration print option, church
name/charity fields, image upload) — needs its own assessment against the
wizard's step types before assuming it's a drop-in like these three were.
Full wizard-UI end-to-end (not just the AJAX spike) also remains outstanding
for LBS/MES/BKS, same as Weekly/Economy's own step 7/8 pass.

## Hard rules and known gotchas

- **Never trust the client price.** The Cart Transform Function recomputes from
  metafields. The front end's `_calc_line_total` is for audit only.
- **Use `lineExpand` for pricing, not `lineUpdate`.** `lineUpdate` is restricted to
  Shopify Plus / Development-plan stores (confirmed via live `update_feature_not_available`
  error) — production (lockiechurch.com) will not be Plus, so `lineUpdate` can never work
  there. `lineExpand` has no such restriction. Use a single-item expand (same variant,
  adjusted price) as the override mechanism. `lineExpand` does not carry the original
  line's properties over automatically — `ExpandedItem.attributes` must be set explicitly
  from properties fetched in the input query.
- **`ExpandedItem.quantity` is per parent-line-unit, not the parent's total quantity.**
  Shopify multiplies it by the parent cart line's own quantity. For a 1:1 price override
  (not a real multi-component bundle), this must be `1` — setting it to the parent line's
  quantity squares the final count (confirmed live: qty 52 → 2704 units charged at the
  per-unit price).
- **The theme wizard MUST add-to-cart with `quantity: 1`, always.** The customer's real
  box count travels as the `_quantity` line item property instead. Reason: checkout rounds
  `fixedPricePerUnit` to 2dp *before* multiplying by `parent_qty × item_qty` — confirmed
  live, qty 52 at unit price `3.140769231` charged as `52 × 3.14 = £163.28`, four pence
  short of `£163.32`. Band unit rates need up to 9dp to reproduce exact totals, and no 2dp
  per-unit price survives multiplication by a quantity > 1. The only exact fix is to make
  that multiplier `1`: with `ExpandedItem.quantity` pinned at `1` and the parent cart
  line's own quantity also `1`, the Function sets `fixedPricePerUnit.amount` to the full
  `lineTotal` directly — no division, no rounding drift. If the wizard ever adds with
  quantity > 1 (legacy/ad-hoc testing), the Function falls back to dividing by it, same
  as before — valid but not cent-exact.
- **Function input query complexity cap is 30 — this limits reading, not the order's
  final property count.** Each individual `attribute(key:)` lookup costs 2, and
  `CartLine` has no bulk/plural attributes field — querying ~20 properties individually
  would blow the cap. Only `_quantity`, `_special_numbering`, `_specials`, and
  `_holydays_count` are queried individually; everything else arrives as one
  `_display_fields_json` attribute (one query-complexity unit) that the Function then
  explodes into many individually-keyed OUTPUT attributes — building the output
  `attributes` array isn't complexity-limited, only the input query is. See the line
  item properties section below.
- **One Cart Transform function per app.** This function must be the sole owner of
  configured-product pricing. Don't install another app that also uses Cart Transform
  against these products.
- **Cart Transform runtime limits:** no network calls, no clock/randomness, ~5ms CPU,
  250KB output. The price table must arrive as function input via metafields, not be
  fetched at runtime.
- **Rounding:** round at the line total to 2dp (`line_total_2dp`). Unit prices carry up
  to 9 decimals. Match WooCommerce's displayed totals exactly — verified values:
  20→£76.67, 52→£146.12, 100→£220.30, 200→£427.42, 500→£925.01.
- **Data anomaly, resolved:** Economy qty 24 was priced £2.70 in old WooCommerce
  data while 20–23 and 25–39 were £2.78. Decided legacy noise, not deliberate —
  seeded as one flat 20–39 band at £2.78. See "Tier 3 (Economy) spike — proven".
- **Sunday-only start date:** the start date step must validate that the chosen date
  is a Sunday.
- **CartTransform activation is manual, not code.** An `afterAuth`/loader-based
  auto-registration (`cartTransformCreate` on app install) was attempted and
  abandoned — it never worked (Cloudflare tunnel errors during the auth flow).
  The live CartTransform (`gid://shopify/CartTransform/127893748` on the dev
  store) was activated by hand via GraphiQL running the `cartTransformCreate`
  mutation directly. **This must be redone manually** (same mutation, via
  GraphiQL or the Admin API) any time the app is reinstalled or moved to a new
  store — there is no code that does this automatically, and none should be
  built without solving the tunnel issue first.
- **Two Partner app configs exist; `lockie-configurator-v2` is the live one.**
  `shopify.app.toml` (client_id `6919f99c...`) is an earlier/unused config.
  `shopify.app.lockie-configurator-v2.toml` (client_id `d0d9273512c...`) is
  what the CLI is actually linked to (`.shopify/project.json`) and what
  `deploy`/`dev` run against — use `--config lockie-configurator-v2` when the
  CLI doesn't pick it up by default.

## Pricing formula (identical in front end and Function)

```
unit_price   = price_table band where from <= qty <= to
base_total   = round2(unit_price * qty)
addons_total = special_numbering_flat (£12)
             + Σ(extra_envelope * count * qty)        // specials
             + Σ(holyday_fee * count * qty)
line_total   = round2(base_total + addons_total)
```

## Line item properties written on add-to-basket

Add-to-cart is always `quantity: 1` (see Hard rules above — required for exact
line totals). `_quantity` carries the customer's real box count and is what
the Function and front-end must use for all pricing math instead of the
native cart quantity.

Kept as individual named properties (queried by the Function for pricing;
hidden — underscore-prefixed, audit/debug only, not meant for customer/office
display): `_quantity`, `_special_numbering`, `_specials`, `_holydays_count`.

**Order-display pass:** everything else — the WooCommerce-style breakdown
(Quantity, Box Colour, Envelope Colour, Text Colour, Heading, per-line
heading values, Verse, Selected Verse, Design, Selected Design, Numbered
from/to, Excluded Numbers, Full Number Range, Holyday specials, Specials,
Start Date, Notes) plus the `calc_unit_price`/`calc_line_total` audit
values — is bundled by `buildCartProperties`/`buildDisplayFields` in
configurator.js into ONE `_display_fields_json` property:
```json
{
  "display": [["Quantity", "52"], ["Box Colour", "Stained Glass"], ["Church/Charity Name", "St Mary's"], ...],
  "audit": [["calc_unit_price", 3.140769231], ["calc_line_total", 163.32]]
}
```
This stays one JSON attribute (one query-complexity unit to fetch) for the
same reason as before — the cap doesn't allow querying ~20 properties
individually. What's different: the Function no longer passes it through
opaquely. `explodeDisplayFields` in `cart_transform_run.ts` parses it and
emits each `display` pair as its own visible attribute (no underscore — so it
shows to both the customer at checkout and fulfilment on the order) and each
`audit` pair re-hidden with a `_` prefix. Building the *output* `attributes`
array isn't complexity-limited (only the input query is), so this is how the
final order gets clean "Label: Value" rows instead of a JSON blob without the
Function's 30-point input-query cap ever being exceeded.

"Full Number Range" is a compact contiguous-run string (`"1-12, 14-53"`), not
every number spelled out — line item property values have a practical length
limit and ranges can run into the hundreds.

`headings_mode` is one dropdown for the whole step (not per-line — see the
headings UX fix). "Selected Design" for a custom image is the real permanent
URL returned by the lockie-uploads Worker (`design_upload_url` in wizard
state) once the upload completes — see the file header's "Uploads pass" note
in configurator.js. "Use previous" is a flag only — it never looks up order
history, fulfilment actions it manually.

Underscore prefix = hidden from customer, visible to fulfilment on the order.

## Launch checklist

Items that only matter once a real production store exists — not actionable
on the dev store, don't investigate early:

- **Confirm the production store is set to GBP at creation.** The dev store
  is already GBP (orders #1001/#1002 charged in £ exactly, per "Stage 3 —
  proven" above) — this is just making sure the real production store,
  which doesn't exist yet, is created with the same setting.

## Product catalogue classification

Full current WooCommerce catalogue (24 products) classified — this is now
settled and drives both Build Order step 9 and the Matrixify plan below.

**Configurator products (Tier 2/3 — build as config, excluded from Matrixify
product import):**
- BS — Weekly ✅ built
- EBS — Economy ✅ built
- LBS — Large Weekly Boxed Sets — ✅ AJAX spike proven (see "LBS spike —
  proven" above); full wizard-UI end-to-end still pending. Confirmed a
  config-only build, same shape as Weekly, no new code.
- MES — Monthly Envelope Boxed Sets — ✅ AJAX spike proven (see "MES spike —
  proven" above); full wizard-UI end-to-end still pending.
- BKS — Booklet Envelope Sets — ✅ AJAX spike proven (see "BKS spike —
  proven" above); full wizard-UI end-to-end still pending. Config-only build
  with one shape variation (no box_colour), confirmed zero code changes.
- LP — Customisable Gift Aid Envelopes — ⬜ not built, **different shape**
  from the boxed-set products: envelope colour, a Gift Aid declaration print
  option, church name/charity fields, image upload. Needs its own assessment
  against the existing wizard config schema before assuming it's a drop-in
  like LBS/MES/BKS — may need new step types, not just new metafield values.

**Standard products (Tier 1 — migrate normally via Matrixify, no config
build):** SBS, MHS, MASS, STOCKSP, LLP, LSC, PGA, ULP, SMP, STOCKMP,
DL-ENV, C6-ENV, C5-ENV, C4-ENV, and the 4 CBM Treasurers Cash Books.

**Order history decision:** old per-order configuration is stored as
Gravity Forms entries (a bespoke plugin's own meta shape, not cleanly
mappable to Shopify line item properties). Of ~4700 orders since 2019,
import the **last 3 years as summary only** (customer/date/total/product) —
detailed old configs stay in the WooCommerce/Gravity Forms archive rather
than being re-mapped into `_display_fields_json` for closed historical
orders.

## Matrixify migration + redirect plan (Step 10)

Staged plan, reviewed and approved — **not yet executed**. Needs WooCommerce
exports from the site owner and a real production store to run against, so
this can't start until both exist. Classification (above) is done; this
stage is otherwise unblocked on the data side once exports + a store exist.

**Stage A — Inventory & classification.** ✅ **DONE** — see "Product
catalogue classification" above. This decides everything downstream — what
Matrixify touches and what every redirect points to. Tier 2/3 products
(BS, EBS, LBS, MES, BKS, LP) are excluded from the Matrixify product import
entirely — these are hand-authored against the metafield schema (Weekly's
price table alone was hand-compressed from 280 WooCommerce rows into 40
bands — deliberate engineering, not something to re-derive mechanically from
an export). Re-importing these as products risks clobbering already-proven
config with mismatched data.

**Stage B — Exports from WooCommerce.** Products CSV (full catalogue, not
just Tier 1 — Tier 2/3 rows are still needed for redirect mapping even
though excluded from import); customers export; orders export (summary-only,
last 3 years — see "Order history decision" above); a full current URL
list (cheapest source: the XML sitemap, catches orphaned-but-indexed URLs a
plugin export might miss).

**Stage C — How Matrixify fits.** Matrixify (Shopify side) is built by the
same vendor as WP All Export (WooCommerce side) — a matched pair with
compatible column templates, designed for exactly this migration. Matrixify
imports products (variants, images-by-URL, metafields, collections, SEO
handle), customers, orders (historical records only, no payment replay),
**and a dedicated Redirects import** that writes straight into Shopify's
native URL Redirects — the bulk-loading mechanism for Stage D, not
hand-entered one row at a time. Can't carry over customer passwords
(everyone resets on first login) or make sense of Woo plugin data with no
Shopify equivalent.

**Stage D — Build the redirect map.** One row per old URL: old path → new
Shopify path. Tier 1 product URLs → the newly-imported product's handle.
Tier 2/3 product URLs → the wizard product's handle — requires BS, EBS, LBS,
MES, BKS, and LP to all exist as built config-driven products first (Build
Order step 9), not just Weekly/Economy. Category/shop pages → matching
Shopify collection. Discontinued/orphaned products → nearest sensible target
(parent collection or homepage), never a bare 404.

**Stage E — Rehearsal, then cutover.** Dry-run the full import (products,
customers, orders, redirects) against the real production store once it
exists and is confirmed GBP (see Launch checklist) — verify a sample of
products/customers landed correctly and a sample of redirects actually
301 — before DNS cutover.

**Stage F — Post-launch monitoring.** Watch Shopify's 404 report / Search
Console for a few weeks after go-live to catch anything the mapping missed.

**Still needed from the site owner before this can start:** the actual
WooCommerce exports themselves (products CSV, customers, orders, and the
sitemap URL or admin access for the full URL list — see Stage B) and a real
production store to import into. Catalogue classification and order-history
depth are already decided — see "Product catalogue classification" above.

## Dev environment

- Shopify Partner dev store (near-empty: Weekly Boxed Sets + Economy Boxed Sets
  while building).
- Shopify CLI for scaffold and deploy. Node.js required.
- Reference theme: Dawn.
- Full catalogue migration happens separately via Matrixify — see "Matrixify
  migration + redirect plan" above, not on the dev build store.

## Reference files in this repo

- `metafield-schema.md` — the metafield shapes for all three tiers.
- `price-table-weekly.json` — Weekly banded price table (paste into `custom.price_table`).
- `weekly-configurator.html` — standalone prototype of the flow + pricing UX (logic reference).
- `verse-design-catalogue.md` — source transcription of the full verse/design stock list.
- `verse-catalogue.json` / `design-catalogue.json` — that catalogue as the JSON seeded into
  `custom.verses` / `custom.designs` on both products by `scripts/setup-dev-store.mjs`.
