import { describe, it, expect } from "vitest";
import { checkMagicBytes, publicMediaUrl } from "./upload";

function bytes(...vals: number[]): ArrayBuffer {
  return new Uint8Array(vals).buffer;
}

describe("checkMagicBytes", () => {
  it("accepts a real PNG header", () => {
    expect(
      checkMagicBytes(
        bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00),
        "image/png"
      )
    ).toBe(true);
  });
  it("rejects a JPEG masquerading as PNG", () => {
    expect(
      checkMagicBytes(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00), "image/png")
    ).toBe(false);
  });
  it("rejects truncated input (fails closed)", () => {
    expect(checkMagicBytes(bytes(0x89, 0x50), "image/png")).toBe(false);
    expect(checkMagicBytes(bytes(), "image/jpeg")).toBe(false);
  });
  it("accepts JPEG / GIF / WEBP", () => {
    expect(checkMagicBytes(bytes(0xff, 0xd8, 0xff, 0xe0), "image/jpeg")).toBe(true);
    expect(
      checkMagicBytes(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61), "image/gif")
    ).toBe(true);
    expect(
      checkMagicBytes(
        bytes(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50),
        "image/webp"
      )
    ).toBe(true);
  });
  it("rejects WEBP with a bad brand", () => {
    expect(
      checkMagicBytes(
        bytes(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x4e, 0x4f, 0x54, 0x21),
        "image/webp"
      )
    ).toBe(false);
  });
  it("finds MP4 ftyp even when not the first box", () => {
    const box = [0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d];
    expect(checkMagicBytes(bytes(...box), "video/mp4")).toBe(true);
    expect(checkMagicBytes(bytes(0x00, 0x01, 0x02, 0x03), "video/mp4")).toBe(false);
  });
  it("accepts clean SVG, rejects scripts and non-SVG text", () => {
    const enc = new TextEncoder();
    expect(
      checkMagicBytes(enc.encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>').buffer as ArrayBuffer, "image/svg+xml")
    ).toBe(true);
    expect(
      checkMagicBytes(enc.encode('<?xml version="1.0"?><svg></svg>').buffer as ArrayBuffer, "image/svg+xml")
    ).toBe(true);
    expect(
      checkMagicBytes(enc.encode('<svg><script>alert(1)</script></svg>').buffer as ArrayBuffer, "image/svg+xml")
    ).toBe(false);
    expect(
      checkMagicBytes(enc.encode('<html><body>hi</body></html>').buffer as ArrayBuffer, "image/svg+xml")
    ).toBe(false);
  });
  it("rejects unknown MIME types", () => {
    expect(checkMagicBytes(bytes(0x25, 0x50, 0x44, 0x46), "application/pdf")).toBe(false);
  });
});

describe("publicMediaUrl", () => {
  const ctx = (url: string) => ({ req: { url } });
  it("derives the origin from the request URL, not the Host header", () => {
    expect(publicMediaUrl(ctx("https://brimwood-api.adamsayani.workers.dev/api/x"), "k1.png")).toBe(
      "https://brimwood-api.adamsayani.workers.dev/api/media/k1.png"
    );
    expect(publicMediaUrl(ctx("http://localhost:8787/api/x"), "k2.png")).toBe(
      "http://localhost:8787/api/media/k2.png"
    );
  });
  it("encodes hostile keys", () => {
    expect(publicMediaUrl(ctx("https://a.example/"), "../x.png")).toBe(
      "https://a.example/api/media/..%2Fx.png"
    );
  });
});
