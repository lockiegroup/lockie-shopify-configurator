# Lockie Church — Configurator Metafield Schema

This is the linchpin of Route B. Every configurable product carries its
options, pricing, and rules as **JSON metafields**. One wizard component reads
these and renders accordingly. Layout becomes data, not code.

The same JSON shape renders Weekly fully, renders Economy with locked options and
no uploads, and is simply *not attached* to a cash book (which becomes a native
Shopify product).

---

## Metafield definitions to create in Shopify admin

Namespace: `custom`

| Key            | Type             | Purpose                                  |
| -------------- | ---------------- | ---------------------------------------- |
| `config`       | JSON             | Master config: steps, options, flags     |
| `price_table`  | JSON             | Quantity → unit-price bands              |
| `addon_fees`   | JSON             | Per-add-on fees                          |
| `verses`       | JSON             | Stock verse list                         |
| `designs`      | JSON             | Stock design list                        |
| `chart_urls`   | JSON             | "View chart" PDF links (verses/designs)  |

> Verses and designs are identical across Weekly/Economy. Rather than a shared
> metaobject, they're seeded as the same JSON value on each product's own
> `custom.verses`/`custom.designs` — same PRODUCT-owned-metafield pattern as
> `config`/`price_table`/`addon_fees`, so the wizard has one read path
> (`readJSON` off an injected `<script>` tag) for every metafield instead of a
> second lookup mechanism for just these two. Source data + the seeding logic:
> `verse-catalogue.json`, `design-catalogue.json`, `scripts/setup-dev-store.mjs`.
>
> `custom.verses` shape: `[{ "code": "V1", "text": "..." }, ...]`.
> `custom.designs` shape: `[{ "code": "C1", "description": "...", "group": "colour" }, ...]`,
> in the exact order shown in the "popular design" dropdown (C1–C14, then
> D1–D30, then denomination codes). `group` is unused by the wizard today —
> reserved for the deferred preview-image pass.
>
> `custom.chart_urls` shape: `{ "verses": "https://...VERSES-2020.pdf", "designs": "https://...designs-2020.pdf" }`.
> Backs the "View verses/designs chart" links next to the Verse/Design mode
> selects (open the PDF in a new tab). Either key may be omitted/empty — the
> wizard hides that link rather than rendering a dead one.

---

## `custom.config` — the master shape

```json
{
  "min_quantity": 20,
  "uploads_enabled": true,
  "steps": {
    "options": {
      "enabled": true,
      "box_colour":     { "values": ["Stained Glass", "Blue", "Pink", "Green", "Yellow"], "locked": false },
      "envelope_colour":{ "values": ["Blue", "Green", "Yellow", "White"], "out_of_stock": ["Blue"], "locked": false },
      "text_colour":    { "values": ["Black"], "locked": true }
    },
    "headings": {
      "enabled": true,
      "lines": ["Church/Charity Name", "Church District", "Church Diocese", "Registered Charity No."]
    },
    "design": {
      "enabled": true,
      "verse": { "enabled": true, "allow_custom": true },
      "design": { "enabled": true, "allow_upload": true }
    },
    "numbering": {
      "enabled": true,
      "special_numbering_fee_key": "special_numbering",
      "specials": ["Christmas", "Easter", "Easter (2)", "Harvest", "Gift Day", "Initial Offering"]
    },
    "holydays": { "enabled": true, "max": 60 },
    "start_date": { "enabled": true, "weekday_only": "Sunday" },
    "notes": { "enabled": true }
  }
}
```

### How each tier expresses itself through this one shape

**Tier 2 — Weekly Boxed Sets (maximal):** as above. All steps enabled, colours
have multiple values with `locked: false`, uploads on, custom verse/design allowed.

**Tier 3 — Economy (locked options, no uploads):** *same shape*, but:
```json
{
  "min_quantity": 20,
  "uploads_enabled": false,
  "steps": {
    "options": {
      "enabled": true,
      "box_colour":     { "values": ["Stained Glass"], "locked": true },
      "envelope_colour":{ "values": ["Manilla"], "locked": true },
      "text_colour":    { "values": ["Black"], "locked": true }
    },
    "design": {
      "enabled": true,
      "verse":  { "enabled": true, "allow_custom": true },
      "design": { "enabled": true, "allow_upload": false }
    },
    "holydays": { "enabled": true, "max": 30 }
    /* ...other steps identical... */
  }
}
```
The renderer turns a single-value `locked` option into a static label, not a
dropdown. `design.design.allow_upload:false` hides the "Add a custom image"
option from the Design step's mode dropdown entirely (Economy still offers
popular/previous/none). Holyday max differs by one number. **No new code —
just different JSON.**

### Headings / Verse / Design step modes

Mirrors the real site's dropdowns, not free-text inputs:

- **Headings**: one mode select for the whole step (matching the live site,
  not per-line) — "Enter new heading" (shows all of `headings.lines` as text
  inputs) or "Use previous heading" (hides them all, just a flag). Only the
  first line is required, and only in "new" mode.
- **Verse**: mode select — "Select a popular verse" (reads `custom.verses`)
  / "Add a custom verse" (gated by `verse.allow_custom`, free text) /
  "Use previous verse" / "No verse". The last two are flags only.
- **Design**: mode select — "Select a popular design" (reads
  `custom.designs`) / "Add a custom image" (gated by `design.allow_upload`,
  the existing stubbed-upload text input) / "Use previous image" / "No design".

**"Use previous" never looks anything up** — no order history, no customer
lookup. It just sets a flag (e.g. `_verse: "use previous"`) on the line item
for fulfilment to action manually.

**Tier 1 — Treasurer Cash Book (not a configurator at all):** no `custom.config`
metafield attached. It's a plain Shopify product, qty × £12.30. The wizard never
renders. Don't over-engineer it.

---

## `custom.price_table` — banded pricing

Store as **bands**, not 280 individual rows. The Cart Transform Function and the
front end both read this. Quantity falls in `[from, to]` inclusive.

Weekly (compressed from the 280-row WooCommerce table):
```json
{
  "currency": "GBP",
  "rounding": "line_total_2dp",
  "bands": [
    { "from": 20,  "to": 24,  "unit": 3.83355 },
    { "from": 25,  "to": 29,  "unit": 3.687504 },
    { "from": 30,  "to": 34,  "unit": 3.51666666667 },
    { "from": 35,  "to": 39,  "unit": 3.34 },
    { "from": 40,  "to": 44,  "unit": 3.1625 }
    /* ...full set generated in price-table-weekly.json... */
  ]
}
```

Economy (only three real tiers — trivial):
```json
{
  "currency": "GBP",
  "rounding": "line_total_2dp",
  "bands": [
    { "from": 20, "to": 24, "unit": 2.78 },
    { "from": 25, "to": 39, "unit": 2.78 },
    { "from": 40, "to": 99, "unit": 1.83 },
    { "from": 100, "to": 300, "unit": 1.75 }
  ]
}
```
> Note the Economy WooCommerce table has a quirk: qty 24 is priced at 2.70 while
> 20–23 and 25–39 are 2.78. Decide whether that's a deliberate break or legacy
> noise before migrating — it's the kind of thing that generates "your price
> changed" support emails.

---

## `custom.addon_fees`

```json
{
  "special_numbering":  { "label": "Special numbering", "amount": 12.00, "type": "flat" },
  "extra_envelope":     { "label": "Additional special envelope", "amount": 0.05, "type": "per_unit_per_set" },
  "printed_extra":      { "label": "Printed additional envelope", "amount": 0.01, "type": "per_unit_per_set" },
  "holyday_special":    { "label": "Holyday special", "amount": 0.05, "type": "per_unit_per_set" }
}
```
Economy overrides `extra_envelope` to `0.03`. Same keys, different amounts.

---

## Price calculation (identical in front end and in the Function)

```
unit_price   = price_table band where from <= qty <= to
base_total   = round2(unit_price * qty)
addons_total = special_numbering_flat
             + Σ(extra_envelope.amount * count * qty)
             + Σ(holyday.amount * count * qty)
line_total   = base_total + addons_total
```

**Critical rule:** the front end computes this for *display only*. The Cart
Transform Function recomputes it server-side from the same metafields and is the
only source of truth for what's charged. Never trust the client's number.

---

## Line item properties written on add-to-basket

**Stage 3 (wired)**: `configurator.js`'s `buildCartProperties`, called from the
"Add to basket" click handler. Cart add is always `quantity: 1`; individual
pricing-critical properties (queried by name in `cart_transform_run.graphql`,
hidden — audit/debug only): `_quantity` (real box count), `_special_numbering`
(`"yes"`/`"no"`, from `hasSpecialNumbering(state)` — the same function the
live £12 summary line uses, so the two can never disagree), `_specials`
(csv), `_holydays_count`.

**Order-display pass:** everything customer/office should actually see —
mirroring the WooCommerce order layout — is bundled by
`buildCartProperties`/`buildDisplayFields` into one `_display_fields_json`
property:
```json
{
  "display": [
    ["Quantity", "52"], ["Box Colour", "Stained Glass"], ["Envelope Colour", "..."], ["Text Colour", "..."],
    ["Heading", "Enter new heading"], ["Church/Charity Name", "..."], ["Church District", "..."],
    ["Verse", "Select a popular verse"], ["Selected Verse", "V3 — The Lord blesses..."],
    ["Design", "Select a popular design"], ["Selected Design", "C1 — Praying hands"],
    ["Numbered from", "1"], ["Numbered to", "53"], ["Excluded Numbers", "13"], ["Full Number Range", "1-12, 14-53"],
    ["Holyday specials", "2"], ["Specials", "Christmas, Easter"],
    ["Start Date", "2026-08-02"], ["Notes", "..."]
  ],
  "audit": [["calc_unit_price", 3.140769231], ["calc_line_total", 163.32]]
}
```
Array-of-pairs, not an object, so field order is unambiguous (this is the
exact row order the office sees on the order). One JSON attribute still costs
just one query-complexity unit to fetch — same reason as before — but
**`explodeDisplayFields` in `cart_transform_run.ts` no longer passes it
through opaquely**: it parses the JSON and emits each `display` pair as its
own visible attribute (no underscore — shown to the customer at checkout
*and* fulfilment on the order) and each `audit` pair re-hidden with a `_`
prefix. Building the Function's *output* isn't complexity-limited, only its
*input query* is — that's how the office ends up with clean "Label: Value"
rows instead of a JSON blob, without the 30-point cap ever being exceeded.

"Full Number Range" is a compact contiguous-run string, not every number
spelled out (line item property values have a practical length limit; ranges
run into the hundreds). `headings_mode`/"Heading" is one flag for the whole
step, not per line (see the headings UX fix). "Selected Design" for a custom
image is the real permanent URL returned by the lockie-uploads Cloudflare
Worker once the upload completes (build order step 6, done). "Use previous"
never looks up order history — it's a flag only, fulfilment actions it
manually.

Underscore-prefixed = hidden from customer in cart/checkout but visible to you on
the order and in fulfilment.
