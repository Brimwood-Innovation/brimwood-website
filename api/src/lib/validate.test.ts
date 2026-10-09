/* Unit tests: src/lib/validate.ts — input boundary helpers. */
import { describe, it, expect } from "vitest";
import { cleanStr, isEmail, isRecord, clientIp } from "./validate";

describe("cleanStr", () => {
  it("trims whitespace", () => {
    expect(cleanStr("  hello  ", 100)).toBe("hello");
  });
  it("caps length", () => {
    expect(cleanStr("abcdef", 3)).toBe("abc");
  });
  it("coerces null/undefined to empty string", () => {
    expect(cleanStr(null, 10)).toBe("");
    expect(cleanStr(undefined, 10)).toBe("");
  });
  it("coerces numbers", () => {
    expect(cleanStr(42, 10)).toBe("42");
  });
});

describe("isEmail", () => {
  it("accepts normal addresses", () => {
    expect(isEmail("a@b.co")).toBe(true);
    expect(isEmail("first.last+tag@example.com")).toBe(true);
  });
  it("rejects malformed addresses", () => {
    for (const bad of ["", "plain", "a@b", "@b.co", "a b@c.co", "a@b c.co", "a@@b.co"]) {
      expect(isEmail(bad), bad).toBe(false);
    }
  });
});

describe("isRecord", () => {
  it("accepts plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });
  it("rejects null, arrays, and primitives", () => {
    for (const v of [null, undefined, [], [1], "x", 42, true]) {
      expect(isRecord(v), String(v)).toBe(false);
    }
  });
});

describe("clientIp", () => {
  const req = (headers: Record<string, string>) =>
    new Request("https://x.test/", { headers }) as Request;
  it("prefers cf-connecting-ip", () => {
    expect(clientIp(req({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8" }))).toBe(
      "1.2.3.4"
    );
  });
  it("falls back to first x-forwarded-for entry", () => {
    expect(clientIp(req({ "x-forwarded-for": "5.6.7.8, 9.9.9.9" }))).toBe("5.6.7.8");
  });
  it("returns 'unknown' with no headers", () => {
    expect(clientIp(req({}))).toBe("unknown");
  });
});
