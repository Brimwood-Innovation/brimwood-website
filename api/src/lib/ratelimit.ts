/* KV-backed sliding-window rate limiter (T16).
 * Same limits as the live worker: 5 intro / 3 newsletter per IP per hour.
 * Backed by RATE_LIMIT_KV so it works across isolates (never in-memory). */

export async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSecs: number
): Promise<boolean> {
  const now = Date.now();
  const windowStart = now - windowSecs * 1000;
  const kvKey = "rl:" + key;
  const raw = await kv.get(kvKey);
  let hits: number[] = [];
  if (raw) {
    try {
      hits = (JSON.parse(raw) as number[]).filter((t) => t > windowStart);
    } catch {
      hits = [];
    }
  }
  if (hits.length >= limit) return false;
  hits.push(now);
  await kv.put(kvKey, JSON.stringify(hits), { expirationTtl: windowSecs });
  return true;
}
