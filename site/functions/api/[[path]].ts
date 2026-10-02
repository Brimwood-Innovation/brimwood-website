/* Pages Functions proxy: /api/* → brimwood-api worker (T-staging-integration).
 * Same-origin from the browser's perspective — no CORS needed, cookies work naturally.
 * The worker URL is configurable via API_WORKER_URL env var (Pages dashboard).
 * Production (brimwoodinnovation.com) is NOT affected — this only runs on the
 * preview Pages project. */

const WORKER_URL = "https://brimwood-api.adamsayani.workers.dev";

export async function onRequest(context: {
  request: Request;
  env: { API_WORKER_URL?: string };
  params: { path?: string[] };
}): Promise<Response> {
  const { request, env } = context;
  const base = env.API_WORKER_URL || WORKER_URL;

  // Rebuild the target URL: /api/<path> → <worker>/api/<path>
  const url = new URL(request.url);
  const target = new URL(base + url.pathname + url.search);

  // Forward the request with original method, headers, and body.
  // Strip host-specific headers that shouldn't leak to the worker.
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };

  // Only attach a body for methods that support one.
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    // Required for streaming the body through.
    (init as any).duplex = "half";
  }

  const res = await fetch(target.toString(), init);

  // Return the worker's response as-is (status, headers, body).
  // Strip content-encoding to avoid double-compression issues.
  const resHeaders = new Headers(res.headers);
  resHeaders.delete("content-encoding");
  resHeaders.delete("content-length");

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: resHeaders,
  });
}
