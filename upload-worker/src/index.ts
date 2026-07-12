/**
 * lockie-uploads Worker — relay for the wizard's Design/Holyday file
 * uploads. Files live in a private R2 bucket; this Worker is the only thing
 * with access to it (via the binding below, never exposed to the browser).
 *
 * POST /upload  — validate + store a file, return its permanent URL.
 * GET  /file/:key — stream a stored file back out.
 *
 * See CLAUDE.md's upload plan for why this shape (private bucket + Worker
 * serving reads, rather than a public bucket URL or presigned links).
 */

export interface Env {
  UPLOADS_BUCKET: R2Bucket;
  UPLOAD_RATE_LIMITER: RateLimit;
  ALLOWED_ORIGINS: string;
}

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

// Extension -> acceptable Content-Type values. Checked primarily by
// extension; browsers report .ai/.xlsx Content-Type inconsistently
// (frequently application/octet-stream), so that's accepted alongside the
// "correct" type for those two rather than hard-rejected.
const ALLOWED_FILE_TYPES: Record<string, string[]> = {
  pdf: ["application/pdf"],
  png: ["image/png"],
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  ai: [
    "application/pdf",
    "application/postscript",
    "application/illustrator",
    "application/octet-stream",
  ],
  xlsx: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/octet-stream",
  ],
};

function getAllowedOrigins(env: Env): string[] {
  return env.ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function corsHeaders(origin: string | null, allowedOrigins: string[]): HeadersInit {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
  if (origin && allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function validateFile(file: File): string | null {
  if (file.size === 0) return "File is empty.";
  if (file.size > MAX_FILE_SIZE) {
    return `File is too large (${(file.size / 1024 / 1024).toFixed(1)}MB) — max is 20MB.`;
  }

  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  const allowedTypes = ALLOWED_FILE_TYPES[ext];
  if (!allowedTypes) {
    return `File type ".${ext}" is not accepted. Allowed: ${Object.keys(ALLOWED_FILE_TYPES).join(", ")}.`;
  }
  if (file.type && !allowedTypes.includes(file.type)) {
    return `File content type "${file.type}" does not match its ".${ext}" extension.`;
  }
  return null;
}

function sanitizeFilename(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe.slice(-100) || "upload";
}

function buildKey(originalName: string): string {
  return `${crypto.randomUUID()}-${sanitizeFilename(originalName)}`;
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  const allowedOrigins = getAllowedOrigins(env);
  const origin = request.headers.get("Origin");
  const headers = corsHeaders(origin, allowedOrigins);

  // CORS (above) only stops browsers. This origin check runs server-side
  // too, so a direct curl/script POST without a matching Origin header is
  // also rejected — see CLAUDE.md's "CORS / auth" section for why this is
  // deterrence, not airtight access control (there's no customer login at
  // this point in the flow to authenticate against).
  if (!origin || !allowedOrigins.includes(origin)) {
    return new Response("Forbidden", { status: 403, headers });
  }

  const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.UPLOAD_RATE_LIMITER.limit({ key: clientIp });
  if (!success) {
    return new Response("Too many uploads — try again in a minute.", {
      status: 429,
      headers,
    });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return new Response("Invalid upload — expected multipart/form-data.", {
      status: 400,
      headers,
    });
  }

  // workers-types types FormData.get() as `string | null` — it doesn't
  // model File, even though the real Workers runtime returns one for file
  // fields. Widen the type here rather than trust the (incomplete) inferred
  // type.
  const file = formData.get("file") as File | string | null;
  if (!(file instanceof File)) {
    return new Response('Missing "file" field.', { status: 400, headers });
  }

  const validationError = validateFile(file);
  if (validationError) {
    return new Response(validationError, { status: 400, headers });
  }

  const key = buildKey(file.name);
  await env.UPLOADS_BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });

  const fileUrl = `${new URL(request.url).origin}/file/${encodeURIComponent(key)}`;

  return new Response(JSON.stringify({ url: fileUrl, filename: file.name }), {
    status: 200,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

async function handleServe(key: string, env: Env): Promise<Response> {
  if (!key) return new Response("Not found", { status: 404 });

  const object = await env.UPLOADS_BUCKET.get(key);
  if (object === null) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  // Keys are UUID-prefixed and never overwritten, so a given URL's content
  // never changes — safe to cache aggressively.
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  // Read access isn't origin-restricted: these links are meant to be opened
  // directly (fulfilment clicking through from a Shopify order), not
  // fetched cross-origin from arbitrary JS.
  headers.set("Access-Control-Allow-Origin", "*");

  return new Response(object.body, { status: 200, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/upload") {
      if (request.method === "OPTIONS") {
        const allowedOrigins = getAllowedOrigins(env);
        const origin = request.headers.get("Origin");
        return new Response(null, {
          status: 204,
          headers: corsHeaders(origin, allowedOrigins),
        });
      }
      if (request.method === "POST") {
        return handleUpload(request, env);
      }
      return new Response("Method not allowed", { status: 405 });
    }

    if (url.pathname.startsWith("/file/") && request.method === "GET") {
      const key = decodeURIComponent(url.pathname.slice("/file/".length));
      return handleServe(key, env);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
