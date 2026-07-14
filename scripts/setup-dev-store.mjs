#!/usr/bin/env node
/**
 * scripts/setup-dev-store.mjs
 *
 * Creates the Weekly Boxed Sets product and all three custom metafield
 * definitions + values on the Shopify dev store.
 *
 * Idempotent: safe to re-run. Existing definitions, the product, and
 * existing metafield values are updated in place rather than duplicated.
 *
 * Prerequisites (one-time)
 * ────────────────────────
 * 1. shopify app dev
 *      Installs the app on the dev store and stores its credentials in the CLI.
 *      Ctrl-C once it's running — you only need the install step, not the tunnel.
 *
 * 2. shopify store auth \
 *        --store <your-dev-store.myshopify.com> \
 *        --scopes write_products,write_metafields,write_cart_transforms
 *      Stores an online access token for this store in the CLI session.
 *      Re-run if you open a new terminal or the token expires.
 *
 * Usage
 * ─────
 * node scripts/setup-dev-store.mjs --store <your-dev-store.myshopify.com>
 *
 * The store domain can also be set via SHOPIFY_FLAG_STORE or
 * SHOPIFY_STORE_DOMAIN in a .env file at the repo root.
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const API_VERSION = "2026-07";

// ── Store domain ──────────────────────────────────────────────────────────────

function loadEnv() {
  try {
    const lines = readFileSync(resolve(ROOT, ".env"), "utf8").split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch {
    // No .env — rely on actual environment variables.
  }
}

loadEnv();

const storeArg = process.argv.indexOf("--store");
const STORE = (
  (storeArg >= 0 ? process.argv[storeArg + 1] : null) ??
  process.env.SHOPIFY_FLAG_STORE ??
  process.env.SHOPIFY_STORE_DOMAIN
)?.replace(/\/+$/, "");

if (!STORE) {
  console.error(
    "\nProvide your dev store domain:\n" +
    "  node scripts/setup-dev-store.mjs --store your-dev-store.myshopify.com\n\n" +
    "Or set SHOPIFY_FLAG_STORE in .env\n\n" +
    "Prerequisites:\n" +
    "  1. shopify app dev\n" +
    "  2. shopify store auth --store <domain> --scopes write_products,write_metafields\n"
  );
  process.exit(1);
}

// ── Temp file management ──────────────────────────────────────────────────────

const tempFiles = [];

function tmpFile(suffix, content) {
  const path = join(tmpdir(), `lockie-setup-${process.pid}-${Date.now()}-${suffix}`);
  writeFileSync(path, content, "utf8");
  tempFiles.push(path);
  return path;
}

function cleanupTempFiles() {
  for (const f of tempFiles) {
    try { unlinkSync(f); } catch {}
  }
}

process.on("exit", cleanupTempFiles);
process.on("SIGINT", () => { cleanupTempFiles(); process.exit(130); });

// ── CLI execution ─────────────────────────────────────────────────────────────
//
// Writes query + variables to temp files (avoids all shell-escaping issues with
// complex JSON values), then calls `shopify store execute --json` and parses stdout.

function execute(query, variables = {}, isMutation = false) {
  const parts = [
    "shopify store execute",
    `--store "${STORE}"`,
    `--query-file "${tmpFile("query.graphql", query.trim())}"`,
    `--version ${API_VERSION}`,
    "--json",
  ];

  if (Object.keys(variables).length > 0) {
    parts.push(`--variable-file "${tmpFile("vars.json", JSON.stringify(variables))}"`);
  }

  if (isMutation) parts.push("--allow-mutations");

  let stdout;
  try {
    stdout = execSync(parts.join(" "), {
      encoding: "utf8",
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const detail = [err.stderr, err.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`shopify store execute failed:\n${detail}`);
  }

  // --json should give clean stdout; extract the outermost JSON object as a fallback.
  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    const m = stdout.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`No JSON in CLI output:\n${stdout}`);
    parsed = JSON.parse(m[0]);
  }

  // shopify store execute --json returns the data payload directly (no { data: } envelope).
  if (parsed.errors?.length) {
    throw new Error(`GraphQL errors:\n${JSON.stringify(parsed.errors, null, 2)}`);
  }
  return parsed;
}

// ── Static data ───────────────────────────────────────────────────────────────

const PRICE_TABLE_WEEKLY = JSON.parse(
  readFileSync(resolve(ROOT, "price-table-weekly.json"), "utf8")
);

const ADDON_FEES_WEEKLY = JSON.parse(
  readFileSync(resolve(ROOT, "addon-fees-weekly.json"), "utf8")
);

// Stock verse/design lists — identical across Weekly/Economy (see
// verse-design-catalogue.md), so seeded onto both products unchanged rather
// than duplicated inline here.
const VERSE_CATALOGUE = JSON.parse(readFileSync(resolve(ROOT, "verse-catalogue.json"), "utf8"));
const DESIGN_CATALOGUE = JSON.parse(readFileSync(resolve(ROOT, "design-catalogue.json"), "utf8"));

// "View verses/designs chart" and "download holydays template" link targets
// — same files on both products. Data-driven/swappable like everything
// else: update these URLs (or move to a JSON file, following the
// verse/design catalogue pattern) rather than hardcoding a link anywhere in
// configurator.js.
const CHART_URLS = {
  verses: "https://cdn.shopify.com/s/files/1/0835/8507/3396/files/VERSES-2020.pdf?v=1783812553",
  designs: "https://cdn.shopify.com/s/files/1/0835/8507/3396/files/designs-2020.pdf?v=1783812555",
  holydays: "https://cdn.shopify.com/s/files/1/0835/8507/3396/files/Holy-Days-2nd-collection-List.xlsx?v=1783879176",
};

const CONFIG_WEEKLY = {
  min_quantity: 20,
  uploads_enabled: true,
  steps: {
    options: {
      enabled: true,
      box_colour:      { values: ["Stained Glass", "Blue", "Pink", "Green", "Yellow"], locked: false },
      envelope_colour: { values: ["Blue", "Green", "Yellow", "White"], out_of_stock: ["Blue"], locked: false },
      text_colour:     { values: ["Black"], locked: true },
    },
    headings: {
      enabled: true,
      lines: ["Church/Charity Name", "Church District", "Church Diocese", "Registered Charity No."],
    },
    design: {
      enabled: true,
      verse:  { enabled: true, allow_custom: true },
      design: { enabled: true, allow_upload: true },
    },
    numbering: {
      enabled: true,
      special_numbering_fee_key: "special_numbering",
      specials: ["Christmas", "Easter", "Easter (2)", "Harvest", "Gift Day", "Initial Offering"],
    },
    holydays:   { enabled: true, max: 60 },
    start_date: { enabled: true, weekday_only: "Sunday" },
    notes:      { enabled: true },
  },
};

// Tier 3 — Economy. Only three real price bands (qty 24's old £2.70 WooCommerce
// rate is legacy noise vs. the £2.78 either side of it — collapsed into one
// 20–39 band; see CLAUDE.md). Same fee keys as Weekly, extra_envelope at 0.03.
// These files are the single source of truth — also read by the Function's
// and the wizard's own pricing tests via pricing-fixtures.json, so seeded
// data and tested data can never drift apart.
const PRICE_TABLE_ECONOMY = JSON.parse(
  readFileSync(resolve(ROOT, "price-table-economy.json"), "utf8")
);

const ADDON_FEES_ECONOMY = JSON.parse(
  readFileSync(resolve(ROOT, "addon-fees-economy.json"), "utf8")
);

const CONFIG_ECONOMY = {
  min_quantity: 20,
  uploads_enabled: false,
  steps: {
    options: {
      enabled: true,
      box_colour:      { values: ["Stained Glass"], locked: true },
      envelope_colour: { values: ["Manilla"], locked: true },
      text_colour:     { values: ["Black"], locked: true },
    },
    headings: {
      enabled: true,
      lines: ["Church/Charity Name", "Church District", "Church Diocese", "Registered Charity No."],
    },
    design: {
      enabled: true,
      verse:  { enabled: true, allow_custom: true },
      design: { enabled: true, allow_upload: false },
    },
    numbering: {
      enabled: true,
      special_numbering_fee_key: "special_numbering",
      specials: ["Christmas", "Easter", "Easter (2)", "Harvest", "Gift Day", "Initial Offering"],
    },
    holydays:   { enabled: true, max: 30 },
    start_date: { enabled: true, weekday_only: "Sunday" },
    notes:      { enabled: true },
  },
};

// Tier 2 — Large Weekly Boxed Sets (LBS). Same full shape as Weekly (uploads on,
// custom verse/design allowed), different colours, min_quantity, and price
// table/fees — sourced from the 2025 catalogue's price-break list and
// compressed the same way Weekly's 280-row table was: each band's `unit` is
// the price-break total ÷ its quantity, `to` runs up to one below the next
// break. See CLAUDE.md "Large Weekly (LBS) spike" for the verification.
const PRICE_TABLE_LBS = JSON.parse(
  readFileSync(resolve(ROOT, "price-table-lbs.json"), "utf8")
);

const ADDON_FEES_LBS = JSON.parse(
  readFileSync(resolve(ROOT, "addon-fees-lbs.json"), "utf8")
);

const CONFIG_LBS = {
  min_quantity: 30,
  uploads_enabled: true,
  steps: {
    options: {
      enabled: true,
      box_colour:      { values: ["Blue", "Yellow"], locked: false },
      envelope_colour: { values: ["Blue", "Yellow", "White"], locked: false },
      text_colour:     { values: ["Black"], locked: true },
    },
    headings: {
      enabled: true,
      lines: ["Church/Charity Name", "Church District", "Church Diocese", "Registered Charity No."],
    },
    design: {
      enabled: true,
      verse:  { enabled: true, allow_custom: true },
      design: { enabled: true, allow_upload: true },
    },
    numbering: {
      enabled: true,
      special_numbering_fee_key: "special_numbering",
      specials: ["Christmas", "Easter", "Easter (2)", "Harvest", "Gift Day", "Initial Offering"],
    },
    holydays:   { enabled: true, max: 60 },
    start_date: { enabled: true, weekday_only: "Sunday" },
    notes:      { enabled: true },
  },
};

// Tier 2 — Monthly Envelope Boxed Sets (MES). Same full shape as Weekly
// (uploads on, custom verse/design allowed, holydays.max 60, and all addon
// fees confirmed by the site owner to match Weekly exactly — Monthly's own
// catalogue confirms the same £12 special-numbering charge). Only the price
// table (4 breaks, simple), colours, and min_quantity differ. See CLAUDE.md
// "MES spike — proven" for the verification.
const PRICE_TABLE_MES = JSON.parse(
  readFileSync(resolve(ROOT, "price-table-mes.json"), "utf8")
);

const ADDON_FEES_MES = JSON.parse(
  readFileSync(resolve(ROOT, "addon-fees-mes.json"), "utf8")
);

const CONFIG_MES = {
  min_quantity: 25,
  uploads_enabled: true,
  steps: {
    options: {
      enabled: true,
      box_colour:      { values: ["Blue", "Green"], locked: false },
      envelope_colour: { values: ["Blue", "Yellow", "Green", "Manilla", "White"], locked: false },
      text_colour:     { values: ["Black"], locked: true },
    },
    headings: {
      enabled: true,
      lines: ["Church/Charity Name", "Church District", "Church Diocese", "Registered Charity No."],
    },
    design: {
      enabled: true,
      verse:  { enabled: true, allow_custom: true },
      design: { enabled: true, allow_upload: true },
    },
    numbering: {
      enabled: true,
      special_numbering_fee_key: "special_numbering",
      specials: ["Christmas", "Easter", "Easter (2)", "Harvest", "Gift Day", "Initial Offering"],
    },
    holydays:   { enabled: true, max: 60 },
    start_date: { enabled: true, weekday_only: "Sunday" },
    notes:      { enabled: true },
  },
};

// Tier 2 — Booklet Envelope Sets (BKS). Same full shape as Weekly (uploads
// on, custom verse/design allowed, holydays.max 60, addon fees confirmed by
// the site owner to match Weekly exactly — the catalogue independently
// confirms the same £12 special-numbering charge and notes booklet supports
// numbering range + exclusions + non-sequential numbering, same as Weekly).
// The one real shape difference: a booklet has no box, so `box_colour` is
// omitted from the options step entirely rather than locked to a single
// value — the wizard's render loop and validator both already skip an
// absent option key cleanly (`if (!opt) return;` in renderOptions, and the
// box_colour validation check is itself conditional on `opts.box_colour`
// existing), so this needed zero code changes, just a metafield with one
// fewer key. See CLAUDE.md "BKS spike — proven" for the verification.
const PRICE_TABLE_BKS = JSON.parse(
  readFileSync(resolve(ROOT, "price-table-bks.json"), "utf8")
);

const ADDON_FEES_BKS = JSON.parse(
  readFileSync(resolve(ROOT, "addon-fees-bks.json"), "utf8")
);

const CONFIG_BKS = {
  min_quantity: 25,
  uploads_enabled: true,
  steps: {
    options: {
      enabled: true,
      envelope_colour: { values: ["Blue", "Yellow", "Green", "Pink", "White"], locked: false },
      text_colour:     { values: ["Black"], locked: true },
    },
    headings: {
      enabled: true,
      lines: ["Church/Charity Name", "Church District", "Church Diocese", "Registered Charity No."],
    },
    design: {
      enabled: true,
      verse:  { enabled: true, allow_custom: true },
      design: { enabled: true, allow_upload: true },
    },
    numbering: {
      enabled: true,
      special_numbering_fee_key: "special_numbering",
      specials: ["Christmas", "Easter", "Easter (2)", "Harvest", "Gift Day", "Initial Offering"],
    },
    holydays:   { enabled: true, max: 60 },
    start_date: { enabled: true, weekday_only: "Sunday" },
    notes:      { enabled: true },
  },
};

const PRODUCTS = [
  { title: "Weekly Boxed Sets",           priceTable: PRICE_TABLE_WEEKLY,  addonFees: ADDON_FEES_WEEKLY,  config: CONFIG_WEEKLY,  verses: VERSE_CATALOGUE, designs: DESIGN_CATALOGUE, chartUrls: CHART_URLS },
  { title: "Economy Boxed Sets",          priceTable: PRICE_TABLE_ECONOMY, addonFees: ADDON_FEES_ECONOMY, config: CONFIG_ECONOMY, verses: VERSE_CATALOGUE, designs: DESIGN_CATALOGUE, chartUrls: CHART_URLS },
  { title: "Large Weekly Boxed Sets",     priceTable: PRICE_TABLE_LBS,     addonFees: ADDON_FEES_LBS,     config: CONFIG_LBS,     verses: VERSE_CATALOGUE, designs: DESIGN_CATALOGUE, chartUrls: CHART_URLS },
  { title: "Monthly Envelope Boxed Sets", priceTable: PRICE_TABLE_MES,     addonFees: ADDON_FEES_MES,     config: CONFIG_MES,     verses: VERSE_CATALOGUE, designs: DESIGN_CATALOGUE, chartUrls: CHART_URLS },
  { title: "Booklet Envelope Sets",       priceTable: PRICE_TABLE_BKS,     addonFees: ADDON_FEES_BKS,     config: CONFIG_BKS,     verses: VERSE_CATALOGUE, designs: DESIGN_CATALOGUE, chartUrls: CHART_URLS },
];

// ── Step 1: Metafield definitions ─────────────────────────────────────────────

function ensureMetafieldDefinitions() {
  console.log("\n── 1. Metafield definitions  (namespace: custom, owner: PRODUCT)");

  const { metafieldDefinitions } = execute(`{
    metafieldDefinitions(namespace: "custom", ownerType: PRODUCT, first: 20) {
      nodes { key id }
    }
  }`);
  const existingKeys = new Set(metafieldDefinitions.nodes.map((n) => n.key));

  const DEFS = [
    { key: "config",      name: "Configurator Config" },
    { key: "price_table", name: "Price Table"          },
    { key: "addon_fees",  name: "Add-on Fees"          },
    { key: "verses",      name: "Verse Catalogue"       },
    { key: "designs",     name: "Design Catalogue"      },
    { key: "chart_urls",  name: "Chart URLs"             },
  ];

  for (const { key, name } of DEFS) {
    if (existingKeys.has(key)) {
      console.log(`   ✓  custom.${key} — already exists, skipping`);
      continue;
    }

    const data = execute(
      `mutation Create($def: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $def) {
          createdDefinition { id key }
          userErrors { field message code }
        }
      }`,
      { def: { namespace: "custom", key, name, type: "json", ownerType: "PRODUCT" } },
      true
    );

    const { createdDefinition, userErrors } = data.metafieldDefinitionCreate;
    if (userErrors.length) throw new Error(`Definition "${key}": ${JSON.stringify(userErrors)}`);
    console.log(`   +  custom.${key} created (${createdDefinition.id})`);
  }
}

// ── Step 2: product ────────────────────────────────────────────────────────────

function ensureProduct(title) {
  console.log(`\n── 2. ${title} product`);

  const { products } = execute(`{
    products(first: 5, query: "title:'${title}'") {
      nodes { id title variants(first: 1) { nodes { id } } }
    }
  }`);

  // Shopify's title query is a fuzzy search; filter for exact match.
  const match = products.nodes.find((p) => p.title === title);
  if (match) {
    console.log(`   ✓  Product already exists`);
    console.log(`      Product GID : ${match.id}`);
    console.log(`      Variant GID : ${match.variants.nodes[0]?.id ?? "(none)"}`);
    return match.id;
  }

  // productSet is the modern, idempotent replacement for productCreate.
  const data = execute(
    `mutation ProductSet($input: ProductSetInput!) {
      productSet(synchronous: true, input: $input) {
        product { id title variants(first: 1) { nodes { id } } }
        userErrors { field message code }
      }
    }`,
    {
      input: {
        title,
        status: "DRAFT",
        productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
        variants: [{
          price: "0.01",
          optionValues: [{ optionName: "Title", name: "Default Title" }],
        }], // Placeholder price — Cart Transform overwrites at checkout.
      },
    },
    true
  );

  const { product, userErrors } = data.productSet;
  if (userErrors.length) throw new Error(`productSet: ${JSON.stringify(userErrors)}`);

  console.log(`   +  Product created`);
  console.log(`      Product GID : ${product.id}`);
  console.log(`      Variant GID : ${product.variants.nodes[0].id}`);
  return product.id;
}

// ── Step 3: Attach metafield values ──────────────────────────────────────────

function attachMetafields(productGid, title, { priceTable, addonFees, config, verses, designs, chartUrls }) {
  console.log(`\n── 3. Metafield values on ${title}`);

  // metafieldsSet is an upsert — creates or updates, always idempotent.
  const data = execute(
    `mutation Set($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { namespace key value }
        userErrors { field message code }
      }
    }`,
    {
      metafields: [
        { namespace: "custom", key: "price_table", type: "json", ownerId: productGid, value: JSON.stringify(priceTable) },
        { namespace: "custom", key: "addon_fees",  type: "json", ownerId: productGid, value: JSON.stringify(addonFees)  },
        { namespace: "custom", key: "config",      type: "json", ownerId: productGid, value: JSON.stringify(config)    },
        { namespace: "custom", key: "verses",      type: "json", ownerId: productGid, value: JSON.stringify(verses)    },
        { namespace: "custom", key: "designs",     type: "json", ownerId: productGid, value: JSON.stringify(designs)   },
        { namespace: "custom", key: "chart_urls",  type: "json", ownerId: productGid, value: JSON.stringify(chartUrls) },
      ],
    },
    true
  );

  const { metafields, userErrors } = data.metafieldsSet;
  if (userErrors.length) throw new Error(`metafieldsSet: ${JSON.stringify(userErrors)}`);

  for (const mf of metafields) {
    const preview = mf.value.length > 60 ? mf.value.slice(0, 57) + "…" : mf.value;
    console.log(`   ✓  ${mf.namespace}.${mf.key}  →  ${preview}`);
  }
}

// ── Cart Transform registration — NOT in this script ─────────────────────────
//
// cartTransformCreate cannot be called via `shopify store execute` because
// `shopifyFunctions` is scoped to the querying API client: a store-level token
// (from `shopify store auth`) is not the app, so it sees no functions.
//
// cartTransformCreate is called automatically from the `afterAuth` hook in
// app/shopify.server.ts, which fires after every OAuth install/re-auth using
// the app's own access token. To activate the function on the store:
//
//   1. shopify app deploy          (push updated scopes + WASM)
//   2. shopify app dev             (start the local tunnel)
//   3. Open the app in the Shopify Admin → OAuth fires → afterAuth registers it

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\nConfiguring dev store: https://${STORE}`);
try {
  ensureMetafieldDefinitions();
  for (const { title, priceTable, addonFees, config, verses, designs, chartUrls } of PRODUCTS) {
    const productGid = ensureProduct(title);
    attachMetafields(productGid, title, { priceTable, addonFees, config, verses, designs, chartUrls });
  }
  console.log("\nAll done. Re-run at any time — the script is idempotent.");
  console.log("CartTransform activation: run `shopify app deploy` then `shopify app dev` and open the app.\n");
} catch (err) {
  console.error("\nSetup failed:", err.message);
  process.exit(1);
}
