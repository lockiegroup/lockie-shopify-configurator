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
| `verses`       | JSON (or shared) | Stock verse list (shared across products)|
| `designs`      | JSON (or shared) | Stock design list (shared across products)|

> Verses and designs are identical across Weekly/Economy, so store them **once**
> as a shared metaobject and reference it, rather than duplicating the list on
> every product.

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
      "design": { "enabled": true, "allow_custom": true, "allow_upload": true }
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
      "design": { "enabled": true, "allow_custom": true, "allow_upload": false }
    },
    "holydays": { "enabled": true, "max": 30 }
    /* ...other steps identical... */
  }
}
```
The renderer turns a single-value `locked` option into a static label, not a
dropdown. `allow_upload:false` + `uploads_enabled:false` removes the file step.
Holyday max differs by one number. **No new code — just different JSON.**

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

```
_box_colour, _envelope_colour, _text_colour,
_heading_1.._heading_4,
_verse_code | _verse_custom,
_design_code | _design_upload_url,
_numbering_from, _numbering_to, _excluded_numbers,
_specials (csv), _holydays_count, _holyday_upload_url,
_start_date, _notes,
_calc_unit_price, _calc_line_total   (function recomputes; these are for audit)
```

Underscore-prefixed = hidden from customer in cart/checkout but visible to you on
the order and in fulfilment.
