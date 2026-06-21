# START HERE — Lockie Church → Shopify Configurator

Everything you need to go from zero to a built, self-serve configurator on
Shopify. Work top to bottom. Steps 1–4 are setup + decisions (an afternoon).
From step 5, Claude Code does the building.

---

## The files in this pack

| File | What it is | What you do with it |
| --- | --- | --- |
| `START-HERE.md` | This runbook | Follow it in order |
| `CLAUDE.md` | Project brief for Claude Code | Commit to repo root |
| `metafield-schema.md` | The metafield JSON shapes for all 3 tiers | Commit; Claude Code reads it |
| `price-table-weekly.json` | Weekly banded price table (40 bands) | Commit; pasted into a metafield |
| `weekly-configurator.html` | Working prototype of the flow + pricing | Open in a browser to demo/validate |

---

## The plan in one paragraph

Customers pay online, so the configured price must be enforced **server-side** —
Shopify won't let front-end JS set the charged price. So the build is: product
options + pricing live as **metafields** (data, not code); one **theme app
extension** wizard reads them and shows a live total; a **Cart Transform Function**
recomputes the real price at checkout and is the only source of truth for what's
charged. Build it against the hardest product (Weekly Boxed Sets) first; the
simpler products (Economy) then fall out as config alone.

---

## STEP 1 — Shopify Partner account + dev store  *(~30 min)*

1. Go to **partners.shopify.com**, sign up (free).
2. Create a **development store** (Partners dashboard → Stores → Add store →
   Development store).
3. Keep it **near-empty** — you only need the Weekly Boxed Sets product on it
   while building. This is your sandbox: it can't take real money and never
   touches anything live.

## STEP 2 — Install the tooling  *(~15 min)*

You already have Node.js. Install the Shopify CLI:

```bash
npm install -g @shopify/cli@latest
shopify version          # prints a version number = success
```

## STEP 3 — Create the GitHub repo  *(~10 min)*

Fresh repo, same pattern as your other Lockie repos. Commit these four files to
the **root**:

- `CLAUDE.md`
- `metafield-schema.md`
- `price-table-weekly.json`
- `weekly-configurator.html`

(`START-HERE.md` too if you like — it's harmless to keep.)

## STEP 4 — Make two decisions now  *(so Claude Code doesn't guess)*

1. **Economy qty-24 anomaly.** In the live data, Economy qty 24 is priced £2.70
   while 20–23 and 25–39 are £2.78. Decide: deliberate price break, or legacy
   noise to clean up? (Doesn't block Weekly, but settle it before Economy.)
2. **Rounding.** Confirm totals round to 2 decimal places at the line level. The
   prototype already does this and matches the live site to the penny, so this is
   almost certainly just "yes".

Both are recorded in `CLAUDE.md`.

---

## STEP 5 — Scaffold the app with Claude Code  *(Claude Code takes over here)*

Open Claude Code in the repo and run:

```bash
shopify app init
shopify app generate extension --template cart_transform
shopify app generate extension --template theme_app_extension
```

## STEP 6 — Build, in this exact order

The sequence matters. Do **not** build UI before the pricing function is proven.

1. **Metafields.** Tell Claude Code: *"Using metafield-schema.md, write a setup
   script that creates custom.config, custom.price_table and custom.addon_fees,
   and attach the Weekly price table from price-table-weekly.json to the Weekly
   product on the dev store."*

2. **Cart Transform spike — THE CRITICAL STEP.** *"Implement the Cart Transform
   function's run() to recompute the line price from price_table + addon_fees
   using lineUpdate. Prove that 52 Weekly sets + special numbering charges exactly
   £163.32 at the dev store checkout."* Verify this at a real checkout before
   moving on. This is the riskiest 5% and it guards the money.

3. **Wizard.** *"Port the flow and pricing logic from weekly-configurator.html
   into the theme app extension, reading the metafields. Live total is display-only;
   the function is the source of truth."*

4. **Uploads.** Wire custom design / holyday file uploads so the file URL attaches
   to the order as a line item property, before checkout.

5. **End-to-end test.** Configure → live total → checkout → confirm the paid order
   shows the correct charge, all line item properties, and the file.

6. **Prove Tier 3 (Economy) by config alone** — write only its metafield JSON, no
   code changes. If this works, the data-driven design is validated.

7. **Migration, in parallel.** Catalogue / customers / orders via **Matrixify**,
   plus **301 redirects** for every old WooCommerce URL. Independent of the
   configurator — can run alongside.

---

## Known gotchas (also in CLAUDE.md — don't skip)

- **Never trust the client price.** The function recomputes from metafields.
- **Use `lineUpdate`, not `lineExpand`** — expand can strip line item properties.
- **One Cart Transform function per app** — it must be the sole owner of
  configured-product pricing.
- **Function runtime:** no network calls, ~5ms CPU; the price table arrives as
  input via metafields, not fetched at runtime.
- **Rounding:** round at the line total to 2dp. Verified Weekly totals —
  20→£76.67, 52→£146.12, 100→£220.30, 200→£427.42, 500→£925.01.
- **Sunday-only start date** — the start-date step must validate this.

---

## Pricing formula (front end and function are identical)

```
unit_price   = price_table band where from <= qty <= to
base_total   = round2(unit_price * qty)
addons_total = special_numbering (£12 flat)
             + Σ(extra_envelope £0.05 * count * qty)   // specials
             + Σ(holyday £0.05 * count * qty)
line_total   = round2(base_total + addons_total)
```

---

## Timeline (effort, not calendar)

- Setup (steps 1–4): an afternoon
- Cart Transform spike: 2–4 days (riskiest)
- Wizard: 1–2 weeks (most labour)
- Uploads + end-to-end testing: 3–5 days
- Economy + remaining products: 2–4 days
- Migration + redirects (parallel): 3–5 days

**~4–7 weeks focused effort; add 25–50% buffer.** Part-time around your other
Lockie work, plan for ~2–3 months calendar. **Don't set a hard go-live date** —
keep WooCommerce live and cut over when the Weekly configurator is proven
end-to-end, not on a calendar deadline.

---

## The single most important rule

Build order is: **metafields → prove the pricing function charges correctly →
then build the wizard on top.** Everything downstream of a verified Cart Transform
function is low-risk. Skipping straight to UI is how you end up with something that
looks finished but mischarges by a penny in the one place that matters.
