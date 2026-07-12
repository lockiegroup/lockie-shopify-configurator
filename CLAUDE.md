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
   **Deferred, but a MUST-HAVE for launch — not dropped.** Two approaches
   were assessed and rejected; a third is the front-runner for when this is
   picked back up:
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
   - ✅ **Front-runner: a minimal serverless upload relay** (Cloudflare
     Worker + R2, or a single Vercel function) — no always-on server to
     maintain, near-zero cost at this volume, returns a file URL that the
     wizard drops straight into the existing `_display_fields_json` cart
     properties alongside every other field. Needs: a Cloudflare or Vercel
     account, the relay function itself, and wiring the Design "custom
     image" and Holyday "upload your filled template" steps to call it —
     otherwise the same shape as the rejected App Proxy plan, just without
     the always-on hosting requirement.
   - **Interim launch fallback if uploads slip:** ship without real uploads
     and show an "email your artwork to [address] quoting your order
     number" note in the Design/Holyday steps instead — acceptable short-term
     since most orders use stock verses/designs, not custom uploads. Not a
     substitute for building real uploads, just a way to not block launch on
     them.
7. Full end-to-end test on the dev store: configure → live total → checkout → paid
   order shows correct charge + all line item properties + file.
   ✅ **DONE for Weekly, minus the file** — real order #1001 placed via the
   actual wizard UI: checkout showed the correct GBP total and the full
   clean labelled breakdown, the paid order carries all of it plus the
   hidden audit properties. See "Stage 3 — proven" below. No file yet since
   uploads (step 6) aren't wired — design/holyday uploads are still the
   Stage 3 stub filename, not a real URL.
8. Confirm Tier 3 (Economy) end-to-end through the actual wizard (options
   correctly locked, simpler price table) — no code changes, config only.
   ✅ **DONE** — real paid order #1002, placed through the actual wizard UI
   against Economy Boxed Sets, charged exactly **£110.28**. Same zero-code-change
   proof as the earlier AJAX spike, now through the real UI: Step 8 is complete
   for both tiers.
9. Catalogue / customer / order migration (Matrixify) + 301 redirects run separately.

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
headings UX fix). `design_upload_name`/"Selected Design" for a custom image is
the Stage 3 stub filename; the real upload URL lands here once uploads are
wired (step 6). "Use previous" is a flag only — it never looks up order
history, fulfilment actions it manually.

Underscore prefix = hidden from customer, visible to fulfilment on the order.

## Launch checklist

Items that only matter once a real production store exists — not actionable
on the dev store, don't investigate early:

- **Set the production Shopify store's currency to GBP at creation.** There
  is no production store yet (still on WooCommerce) — this isn't a "check,"
  it's a one-time setting to get right when the store is created. All pricing
  proven so far (£163.32, £110.28, etc.) is dev-store math validated against
  GBP price-table values; it depends on the real store also being set to GBP.

## Dev environment

- Shopify Partner dev store (near-empty: Weekly Boxed Sets + Economy Boxed Sets
  while building).
- Shopify CLI for scaffold and deploy. Node.js required.
- Reference theme: Dawn.
- Full catalogue migration happens separately via Matrixify, not on the dev build store.

## Reference files in this repo

- `metafield-schema.md` — the metafield shapes for all three tiers.
- `price-table-weekly.json` — Weekly banded price table (paste into `custom.price_table`).
- `weekly-configurator.html` — standalone prototype of the flow + pricing UX (logic reference).
- `verse-design-catalogue.md` — source transcription of the full verse/design stock list.
- `verse-catalogue.json` / `design-catalogue.json` — that catalogue as the JSON seeded into
  `custom.verses` / `custom.designs` on both products by `scripts/setup-dev-store.mjs`.
