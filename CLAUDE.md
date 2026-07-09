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
   `theme_app_extension` extensions.
2. Create metafield definitions on the dev store from `metafield-schema.md`
   (write a setup script). Attach the Weekly `price_table` from
   `price-table-weekly.json`.
3. **Spike the Cart Transform Function in isolation first.** Prove that a cart line
   for 52 Weekly sets + special numbering charges exactly £163.32 at the dev store
   checkout, recomputed server-side. Do this BEFORE building any UI.
4. Build the theme app extension wizard, porting the logic from
   `weekly-configurator.html`, reading the metafields.
5. Wire uploads; confirm the file URL survives onto the paid order.
6. Full end-to-end test on the dev store: configure → live total → checkout → paid
   order shows correct charge + all line item properties + file.
7. Prove Tier 3 (Economy) by writing only its metafield JSON — no code changes.
8. Catalogue / customer / order migration (Matrixify) + 301 redirects run separately.

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
- **Function input query complexity cap is 30.** Each individual `attribute(key:)`
  lookup costs 2, and `CartLine` has no bulk/plural attributes field — querying all
  ~22 `_`-prefixed properties individually (53) exceeds the cap. Only `_quantity`,
  `_special_numbering`, `_specials`, and `_holydays_count` are queried/passed through
  individually; see the line item properties section below for how the rest are handled.
- **One Cart Transform function per app.** This function must be the sole owner of
  configured-product pricing. Don't install another app that also uses Cart Transform
  against these products.
- **Cart Transform runtime limits:** no network calls, no clock/randomness, ~5ms CPU,
  250KB output. The price table must arrive as function input via metafields, not be
  fetched at runtime.
- **Rounding:** round at the line total to 2dp (`line_total_2dp`). Unit prices carry up
  to 9 decimals. Match WooCommerce's displayed totals exactly — verified values:
  20→£76.67, 52→£146.12, 100→£220.30, 200→£427.42, 500→£925.01.
- **Data anomaly to resolve before migration:** Economy qty 24 is priced £2.70 while
  20–23 and 25–39 are £2.78. Decide if deliberate or legacy noise.
- **Sunday-only start date:** the start date step must validate that the chosen date
  is a Sunday.

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

Kept as individual named properties (queried and pricing-relevant, and worth
fulfilment seeing as their own columns): `_quantity`, `_special_numbering`,
`_specials`, `_holydays_count`.

Everything else is written as a single JSON-encoded `_config_json` property
(the Cart Transform Function's input query complexity cap of 30 doesn't allow
querying ~22 properties individually — see Hard rules above):
`_box_colour, _envelope_colour, _text_colour, _heading_1.._heading_4,
_verse | _verse_custom, _design | _design_upload_url, _numbering_from,
_numbering_to, _excluded_numbers, _holyday_upload_url, _start_date, _notes,
_calc_unit_price, _calc_line_total`. The Function passes `_config_json` through
opaquely onto the expanded line without parsing it — fulfilment/admin tooling
is responsible for decoding it for display.

Underscore prefix = hidden from customer, visible to fulfilment on the order.

## Dev environment

- Shopify Partner dev store (near-empty: just the Weekly product while building).
- Shopify CLI for scaffold and deploy. Node.js required.
- Reference theme: Dawn.
- Full catalogue migration happens separately via Matrixify, not on the dev build store.

## Reference files in this repo

- `metafield-schema.md` — the metafield shapes for all three tiers.
- `price-table-weekly.json` — Weekly banded price table (paste into `custom.price_table`).
- `weekly-configurator.html` — standalone prototype of the flow + pricing UX (logic reference).
