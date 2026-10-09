/* Upload hardening helpers (security-max).
 *
 * 1. checkMagicBytes: `file.type` is browser-supplied and trivially spoofed;
 *    the extension allowlist alone cannot stop a polyglot or a renamed
 *    executable. Verify the first bytes of the actual content before R2.put.
 *    Fails closed on truncation or unknown types.
 * 2. publicMediaUrl: build public media URLs from the runtime request origin,
 *    never from the Host header (a poisoned Host would make clients
 *    render/store attacker-controlled URLs).
 */

const SIGS: Record<string, { offset: number; bytes: number[] }[]> = {
  "image/png": [
    { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  ],
  "image/jpeg": [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  "image/gif": [{ offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }], // "GIF8"
  "image/webp": [
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // "RIFF"
    { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // "WEBP"
  ],
};

const MP4_FTYP = [0x66, 0x74, 0x79, 0x70]; // "ftyp"

/** True when the buffer's leading bytes match the claimed MIME type. */
export function checkMagicBytes(buf: ArrayBuffer, mime: string): boolean {
  if (mime === "image/svg+xml") return checkSvg(buf);
  if (mime === "video/mp4") return scanFor(buf, MP4_FTYP, 128);
  const sigs = SIGS[mime];
  if (!sigs) return false;
  const b = new Uint8Array(buf);
  return sigs.every(
    ({ offset, bytes }) =>
      offset + bytes.length <= b.length &&
      bytes.every((byte, i) => b[offset + i] === byte)
  );
}

/** Scan the first `window` bytes for a signature (MP4's ftyp box is not
 *  always the very first box, so an offset-anchored check false-rejects). */
function scanFor(buf: ArrayBuffer, sig: number[], window: number): boolean {
  const b = new Uint8Array(buf);
  const end = Math.min(window, b.length);
  outer: for (let o = 0; o + sig.length <= end; o++) {
    for (let i = 0; i < sig.length; i++) {
      if (b[o + i] !== sig[i]) continue outer;
    }
    return true;
  }
  return false;
}

function checkSvg(buf: ArrayBuffer): boolean {
  const text = new TextDecoder().decode(buf).replace(/^[\uFEFF\s]*/, "");
  if (text.startsWith("<svg")) {
    // ok
  } else if (text.startsWith("<?xml")) {
    // An XML prolog alone proves nothing — require the svg root nearby.
    if (!text.slice(0, 2048).includes("<svg")) return false;
  } else {
    return false;
  }
  // Defense in depth: SVGs are served as attachment downloads today, but
  // embedded scripts would become stored XSS the day anything serves one
  // inline. Reject them at the door.
  if (/<script[\s>]/i.test(text)) return false;
  return true;
}

/** Public URL for a media key, derived from the runtime request origin —
 *  never from the Host header. Falls back to the production API origin only
 *  if the request URL is somehow unparseable (never observed). */
export function publicMediaUrl(
  c: { req: { url: string } },
  key: string
): string {
  let origin = "";
  try {
    origin = new URL(c.req.url).origin;
  } catch {
    origin = "";
  }
  if (!origin) origin = "https://brimwood-api.adamsayani.workers.dev";
  return `${origin}/api/media/${encodeURIComponent(key)}`;
}
