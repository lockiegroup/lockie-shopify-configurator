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
 *        --scopes write_products
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

  // Normalise: CLI may return { data } directly or wrap in { result: { data } }.
  const result = parsed.result ?? parsed;
  if (result.errors?.length) {
    throw new Error(`GraphQL errors:\n${JSON.stringify(result.errors, null, 2)}`);
  }
  return result.data;
}

// ── Static data ───────────────────────────────────────────────────────────────

const PRICE_TABLE = JSON.parse(
  readFileSync(resolve(ROOT, "price-table-weekly.json"), "utf8")
);

const ADDON_FEES = {
  special_numbering: { label: "Special numbering",           amount: 12.00, type: "flat"             },
  extra_envelope:    { label: "Additional special envelope", amount:  0.05, type: "per_unit_per_set" },
  printed_extra:     { label: "Printed additional envelope", amount:  0.01, type: "per_unit_per_set" },
  holyday_special:   { label: "Holyday special",             amount:  0.05, type: "per_unit_per_set" },
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

// ── Step 2: Weekly Boxed Sets product ─────────────────────────────────────────

function ensureProduct() {
  console.log("\n── 2. Weekly Boxed Sets product");

  const { products } = execute(`{
    products(first: 5, query: "title:'Weekly Boxed Sets'") {
      nodes { id title variants(first: 1) { nodes { id } } }
    }
  }`);

  // Shopify's title query is a fuzzy search; filter for exact match.
  const match = products.nodes.find((p) => p.title === "Weekly Boxed Sets");
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
        title: "Weekly Boxed Sets",
        status: "DRAFT",
        variants: [{ price: "0.01" }], // Placeholder — Cart Transform overwrites at checkout.
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

function attachMetafields(productGid) {
  console.log("\n── 3. Metafield values on Weekly Boxed Sets");

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
        { namespace: "custom", key: "price_table", type: "json", ownerId: productGid, value: JSON.stringify(PRICE_TABLE)   },
        { namespace: "custom", key: "addon_fees",  type: "json", ownerId: productGid, value: JSON.stringify(ADDON_FEES)    },
        { namespace: "custom", key: "config",      type: "json", ownerId: productGid, value: JSON.stringify(CONFIG_WEEKLY) },
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

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\nConfiguring dev store: https://${STORE}`);
try {
  ensureMetafieldDefinitions();
  const productGid = ensureProduct();
  attachMetafields(productGid);
  console.log("\nAll done. Re-run at any time — the script is idempotent.\n");
} catch (err) {
  console.error("\nSetup failed:", err.message);
  process.exit(1);
}
