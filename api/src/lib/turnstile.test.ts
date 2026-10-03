/* Unit tests: src/lib/turnstile.ts — fails closed, never throws. */
import { describe, it, expect } from "vitest";
import { verifyTurnstile } from "./turnstile";
import { stubFetch } from "../test/helpers";

const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });

describe("verifyTurnstile", () => {
  it("fails closed when no secret is configured", async () => {
    const r = await verifyTurnstile("tok", undefined);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not configured/i);
  });

  it("fails closed on missing/blank token without calling the network", async () => {
    let called = 0;
    const restore = stubFetch(() => {
      called++;
      return json({ success: true });
    });
    try {
      for (const t of ["", "   ", undefined, null, 123]) {
        const r = await verifyTurnstile(t, "secret");
        expect(r.ok, String(t)).toBe(false);
      }
      expect(called).toBe(0);
    } finally {
      restore();
    }
  });

  it("returns ok on success:true", async () => {
    const restore = stubFetch(() => json({ success: true }));
    try {
      expect(await verifyTurnstile("tok", "secret", "1.2.3.4")).toEqual({ ok: true });
    } finally {
      restore();
    }
  });

  it("fails closed on success:false", async () => {
    const restore = stubFetch(() => json({ success: false, "error-codes": ["bad-token"] }));
    try {
      const r = await verifyTurnstile("tok", "secret");
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("fails closed when the network throws (no exception escapes)", async () => {
    const restore = stubFetch(() => {
      throw new Error("boom");
    });
    try {
      const r = await verifyTurnstile("tok", "secret");
      expect(r.ok).toBe(false);
    } finally {
      restore();
    }
  });

  it("sends secret, response and remoteip to siteverify", async () => {
    let seen: Record<string, string> = {};
    const restore = stubFetch((_url, init) => {
      seen = Object.fromEntries(new URLSearchParams(String(init?.body)));
      return json({ success: true });
    });
    try {
      await verifyTurnstile("tok123", "s3cret", "9.9.9.9");
      expect(seen.secret).toBe("s3cret");
      expect(seen.response).toBe("tok123");
      expect(seen.remoteip).toBe("9.9.9.9");
    } finally {
      restore();
    }
  });
});
