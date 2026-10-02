/* Input validation at the boundary (T16). All external input is
 * trimmed, length-capped, and shape-checked here; downstream code trusts it. */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function cleanStr(v: unknown, max: number): string {
  return String(v ?? "").trim().slice(0, max);
}

export function isEmail(v: string): boolean {
  return EMAIL_RE.test(v);
}

export function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
