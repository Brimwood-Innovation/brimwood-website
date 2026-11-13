import { describe, it, expect } from "vitest";
import { hmacSha256Hex, codeHmac } from "./hmac";

describe("hmacSha256Hex", () => {
  it("matches the RFC 4231 test case 2 vector", async () => {
    // Key "Jefe", data "what do ya want for nothing?"
    expect(await hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
    );
  });

  it("is deterministic and key-sensitive", async () => {
    const a = await hmacSha256Hex("k1", "BRIM-AAAA-BBBB");
    expect(a).toBe(await hmacSha256Hex("k1", "BRIM-AAAA-BBBB"));
    expect(a).not.toBe(await hmacSha256Hex("k2", "BRIM-AAAA-BBBB"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("codeHmac", () => {
  const env = { SESSION_SECRET: "test-session-secret" };

  it("separates kinds: the same value hashes differently per kind", async () => {
    const invite = await codeHmac(env, "invite-code", "BRIM-AAAA-BBBB");
    const email = await codeHmac(env, "email-code", "BRIM-AAAA-BBBB");
    expect(invite).not.toBe(email);
    expect(invite).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed without a configured secret", async () => {
    await expect(codeHmac({}, "invite-code", "X")).rejects.toThrow(/SESSION_SECRET/);
  });
});
