/* D1-backed fixed-window rate limiter (F9).
 * One atomic UPSERT per check. Parallel bursts are serialized by SQLite,
 * so the limit is exact. No KV writes.
 */
export async function checkRateLimitD1(
  db: D1Database,
  key: string,
  limit: number,
  windowSecs: number
): Promise<boolean> {
  const now = Date.now();
  const windowMs = windowSecs * 1000;
  const row = (await db
    .prepare(
      `INSERT INTO rate_limits (key, count, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN ?2 - rate_limits.window_start >= ?3 THEN 1 ELSE rate_limits.count + 1 END,
         window_start = CASE WHEN ?2 - rate_limits.window_start >= ?3 THEN ?2 ELSE rate_limits.window_start END
       RETURNING count`
    )
    .bind(key, now, windowMs)
    .first()) as { count: number } | null;
  return (row?.count ?? 1) <= limit;
}

/* Remove expired rate-limit rows. Call from a scheduled job. */
export async function pruneRateLimits(db: D1Database): Promise<void> {
  await db
    .prepare("DELETE FROM rate_limits WHERE window_start < ?")
    .bind(Date.now() - 3600 * 1000)
    .run();
}
