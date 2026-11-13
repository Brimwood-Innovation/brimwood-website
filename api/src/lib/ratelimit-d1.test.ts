/* F9 acceptance: D1-backed rate limiter.
 * - One atomic UPSERT per check (no read-modify-write race).
 * - A 20-request parallel burst is limited correctly.
 * - Window reset works.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkRateLimitD1, pruneRateLimits } from "./ratelimit-d1";
import { mockD1 } from "../test/helpers";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/* In-memory simulation of the atomic UPSERT ... RETURNING count. */
function upsertHandler() {
  const store = new Map<string, { count: number; window_start: number }>();
  return (sql: string, params: any[]) => {
    if (/insert\s+into\s+rate_limits/i.test(sql)) {
      const [key, now, windowMs] = params as [string, number, number];
      let row = store.get(key);
      if (!row || now - row.window_start >= windowMs) {
        row = { count: 1, window_start: now };
      } else {
        row = { count: row.count + 1, window_start: row.window_start };
      }
      store.set(key, row);
      return { row: { count: row.count } };
    }
    if (/delete\s+from\s+rate_limits/i.test(sql)) {
      return { row: null };
    }
  };
}

describe("checkRateLimitD1", () => {
  it("allows requests under the limit", async () => {
    const db = mockD1(upsertHandler());
    for (let i = 0; i < 5; i++) {
      expect(await checkRateLimitD1(db as any, "k", 5, 3600)).toBe(true);
    }
  });

  it("blocks once the limit is reached", async () => {
    const db = mockD1(upsertHandler());
    for (let i = 0; i < 5; i++) {
      await checkRateLimitD1(db as any, "k", 5, 3600);
    }
    expect(await checkRateLimitD1(db as any, "k", 5, 3600)).toBe(false);
  });

  it("limits a 20-request parallel burst correctly", async () => {
    const db = mockD1(upsertHandler());
    const results = await Promise.all(
      Array.from({ length: 20 }, () => checkRateLimitD1(db as any, "burst", 5, 3600))
    );
    const allowed = results.filter(Boolean).length;
    expect(allowed).toBe(5);
  });

  it("resets after the window expires", async () => {
    const db = mockD1(upsertHandler());
    for (let i = 0; i < 3; i++) {
      await checkRateLimitD1(db as any, "k", 3, 60);
    }
    expect(await checkRateLimitD1(db as any, "k", 3, 60)).toBe(false);
    vi.advanceTimersByTime(61 * 1000);
    expect(await checkRateLimitD1(db as any, "k", 3, 60)).toBe(true);
  });

  it("tracks keys independently", async () => {
    const db = mockD1(upsertHandler());
    for (let i = 0; i < 3; i++) {
      await checkRateLimitD1(db as any, "a", 3, 60);
    }
    expect(await checkRateLimitD1(db as any, "a", 3, 60)).toBe(false);
    expect(await checkRateLimitD1(db as any, "b", 3, 60)).toBe(true);
  });
});

describe("pruneRateLimits", () => {
  it("issues a DELETE for old rows", async () => {
    const db = mockD1(upsertHandler());
    await pruneRateLimits(db as any);
    const del = db.calls.find((c) => /delete\s+from\s+rate_limits/i.test(c.sql));
    expect(del).toBeDefined();
  });
});
