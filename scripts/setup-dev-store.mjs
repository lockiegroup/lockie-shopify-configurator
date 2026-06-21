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
 * Prerequisites
 * ─────────────
 * 1. Copy .env.example → .env and fill in the two variables.
 * 2. node scripts/setup-dev-store.mjs
 *
 * Node 18+ required (uses built-in fetch).
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Env loading ───────────────────────────────────────────────────────────────

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
    // No .env file — fall through to actual environment variables.
  }
}

loadEnv();

const STORE = process.env.SHOPIFY_STORE_DOMAIN?.replace(/\/+$/, "");
const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VERSION = "2026-07";

if (!STORE || !TOKEN) {
  console.error(
    "\nMissing env vars. Copy .env.example → .env and fill in:\n" +
    "  SHOPIFY_STORE_DOMAIN     e.g. your-dev-store.myshopify.com\n" +
    "  SHOPIFY_ADMIN_API_TOKEN  from a custom app in the dev store admin\n"
  );
  process.exit(1);
}

const GQL_URL = `https://${STORE}/admin/api/${API_VERSION}/graphql.json`;
const AUTH_HEADERS = { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN };

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function gql(query, variables = {}) {
  const res = await fetch(GQL_URL, {
    method: "POST",
    headers: AUTH_HEADERS,
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from Shopify GraphQL: ${await res.text()}`);
  }
  const { data, errors } = await res.json();
  if (errors?.length) throw new Error(`GraphQL errors:\n${JSON.stringify(errors, null, 2)}`);
  return data;
}

// ── Static data ───────────────────────────────────────────────────────────────

const PRICE_TABLE = JSON.parse(
  readFileSync(resolve(ROOT, "price-table-weekly.json"), "utf8")
);

const ADDON_FEES = {
  special_numbering: { label: "Special numbering",              amount: 12.00, type: "flat"             },
  extra_envelope:    { label: "Additional special envelope",    amount:  0.05, type: "per_unit_per_set" },
  printed_extra:     { label: "Printed additional envelope",    amount:  0.01, type: "per_unit_per_set" },
  holyday_special:   { label: "Holyday special",                amount:  0.05, type: "per_unit_per_set" },
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
      design: { enabled: true, allow_custom: true, allow_upload: true },
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

// ── Step 1: Metafield definitions ─────────────────────────────────────────────

async function ensureMetafieldDefinitions() {
  console.log("\n── 1. Metafield definitions  (namespace: custom, owner: PRODUCT)");

  const { metafieldDefinitions } = await gql(`{
    metafieldDefinitions(namespace: "custom", ownerType: PRODUCT, first: 20) {
      nodes { key id }
    }
  }`);
  const existingKeys = new Set(metafieldDefinitions.nodes.map((n) => n.key));

  const DEFS = [
    { key: "config",      name: "Configurator Config" },
    { key: "price_table", name: "Price Table"          },
    { key: "addon_fees",  name: "Add-on Fees"          },
  ];

  for (const { key, name } of DEFS) {
    if (existingKeys.has(key)) {
      console.log(`   ✓  custom.${key} — already exists, skipping`);
      continue;
    }

    const data = await gql(
      `mutation Create($def: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $def) {
          createdDefinition { id key }
          userErrors { field message code }
        }
      }`,
      { def: { namespace: "custom", key, name, type: "json", ownerType: "PRODUCT" } }
    );

    const { createdDefinition, userErrors } = data.metafieldDefinitionCreate;
    if (userErrors.length) throw new Error(`Definition "${key}": ${JSON.stringify(userErrors)}`);
    console.log(`   +  custom.${key} created (${createdDefinition.id})`);
  }
}

// ── Step 2: Weekly Boxed Sets product ─────────────────────────────────────────

async function ensureProduct() {
  console.log("\n── 2. Weekly Boxed Sets product");

  const { products } = await gql(`{
    products(first: 5, query: "title:'Weekly Boxed Sets'") {
      nodes { id title variants(first: 1) { nodes { id } } }
    }
  }`);

  // Filter for exact title — Shopify's title query is a fuzzy search.
  const match = products.nodes.find((p) => p.title === "Weekly Boxed Sets");
  if (match) {
    const variantId = match.variants.nodes[0]?.id ?? "(no variant)";
    console.log(`   ✓  Product already exists`);
    console.log(`      Product GID : ${match.id}`);
    console.log(`      Variant GID : ${variantId}`);
    return match.id;
  }

  // productSet is the modern replacement for the deprecated productCreate.
  // synchronous: true waits for completion before returning.
  const data = await gql(
    `mutation ProductSet($input: ProductSetInput!) {
      productSet(synchronous: true, input: $input) {
        product { id title variants(first: 1) { nodes { id } } }
        userErrors { field message code }
      }
    }`,
    {
      input: {
        title: "Weekly Boxed Sets",
        status: "DRAFT",
        // Placeholder price — Cart Transform overwrites this at checkout.
        variants: [{ price: "0.01" }],
      },
    }
  );

  const { product, userErrors } = data.productSet;
  if (userErrors.length) throw new Error(`productSet: ${JSON.stringify(userErrors)}`);

  console.log(`   +  Product created`);
  console.log(`      Product GID : ${product.id}`);
  console.log(`      Variant GID : ${product.variants.nodes[0].id}`);
  return product.id;
}

// ── Step 3: Attach metafield values ──────────────────────────────────────────

async function attachMetafields(productGid) {
  console.log("\n── 3. Metafield values on Weekly Boxed Sets");

  const metafields = [
    { namespace: "custom", key: "price_table", type: "json", ownerId: productGid, value: JSON.stringify(PRICE_TABLE)   },
    { namespace: "custom", key: "addon_fees",  type: "json", ownerId: productGid, value: JSON.stringify(ADDON_FEES)    },
    { namespace: "custom", key: "config",      type: "json", ownerId: productGid, value: JSON.stringify(CONFIG_WEEKLY) },
  ];

  // metafieldsSet is the idempotent upsert mutation — creates or updates.
  const data = await gql(
    `mutation Set($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { namespace key value }
        userErrors { field message code }
      }
    }`,
    { metafields }
  );

  const { metafields: set, userErrors } = data.metafieldsSet;
  if (userErrors.length) throw new Error(`metafieldsSet: ${JSON.stringify(userErrors)}`);

  for (const mf of set) {
    const preview = mf.value.length > 60 ? mf.value.slice(0, 57) + "…" : mf.value;
    console.log(`   ✓  ${mf.namespace}.${mf.key}  →  ${preview}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nConfiguring dev store: https://${STORE}`);
  await ensureMetafieldDefinitions();
  const productGid = await ensureProduct();
  await attachMetafields(productGid);
  console.log("\nAll done. Re-run at any time — the script is idempotent.\n");
}

main().catch((err) => {
  console.error("\nSetup failed:", err.message);
  process.exit(1);
});
