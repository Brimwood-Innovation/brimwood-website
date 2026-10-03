/* Unit tests: src/lib/ratelimit.ts — sliding-window limiter over KV. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkRateLimit } from "./ratelimit";
import { mockKV, type MockKV } from "../test/helpers";

/** MockKV → real KVNamespace type for the typed helper under test. */
const kvn = (kv: MockKV) => kv as unknown as KVNamespace;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("checkRateLimit", () => {
  it("allows requests under the limit", async () => {
    const kv = mockKV();
    for (let i = 0; i < 5; i++) {
      expect(await checkRateLimit(kvn(kv), "k", 5, 3600)).toBe(true);
    }
  });

  it("blocks once the limit is reached within the window", async () => {
    const kv = mockKV();
    for (let i = 0; i < 5; i++) await checkRateLimit(kvn(kv), "k", 5, 3600);
    expect(await checkRateLimit(kvn(kv), "k", 5, 3600)).toBe(false);
    expect(await checkRateLimit(kvn(kv), "k", 5, 3600)).toBe(false);
  });

  it("resets after the window passes", async () => {
    const kv = mockKV();
    for (let i = 0; i < 5; i++) await checkRateLimit(kvn(kv), "k", 5, 3600);
    expect(await checkRateLimit(kvn(kv), "k", 5, 3600)).toBe(false);
    vi.advanceTimersByTime(3601 * 1000);
    expect(await checkRateLimit(kvn(kv), "k", 5, 3600)).toBe(true);
  });

  it("tracks keys independently", async () => {
    const kv = mockKV();
    for (let i = 0; i < 5; i++) await checkRateLimit(kvn(kv), "a", 5, 3600);
    expect(await checkRateLimit(kvn(kv), "a", 5, 3600)).toBe(false);
    expect(await checkRateLimit(kvn(kv), "b", 5, 3600)).toBe(true);
  });

  it("recovers from corrupt KV data instead of throwing", async () => {
    const kv = mockKV({ "rl:k": "not-json{{{" });
    expect(await checkRateLimit(kvn(kv), "k", 5, 3600)).toBe(true);
  });

  it("prunes stale hits so old traffic does not count", async () => {
    const kv = mockKV();
    await checkRateLimit(kvn(kv), "k", 2, 60);
    vi.advanceTimersByTime(61 * 1000);
    await checkRateLimit(kvn(kv), "k", 2, 60);
    // Both old hits expired; this second fresh hit must still be allowed.
    expect(await checkRateLimit(kvn(kv), "k", 2, 60)).toBe(true);
    expect(await checkRateLimit(kvn(kv), "k", 2, 60)).toBe(false);
  });
});
