/* Pages Functions proxy: /api/* -> brimwood-api worker.
 * Same-origin from the browser — no CORS needed, cookies work naturally. */

const WORKER_URL = "https://brimwood-api.adamsayani.workers.dev";

export async function onRequest(context) {
  const { request, env } = context;
  const base = (env && env.API_WORKER_URL) || WORKER_URL;

  const url = new URL(request.url);
  const target = base + url.pathname + url.search;

  const headers = new Headers(request.headers);
  headers.delete("host");

  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  const res = await fetch(target, init);
  const resHeaders = new Headers(res.headers);
  resHeaders.delete("content-encoding");
  resHeaders.delete("content-length");

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: resHeaders,
  });
}
