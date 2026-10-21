/* HMAC helpers for short codes (SCHEMA S4 and S9, audit 06).
 *
 * Short codes (invite codes, 6-digit email codes, recovery codes) carry too
 * little entropy for a plain hash: anyone with the table could reverse them
 * in seconds. HMAC-SHA256 keyed with a Worker-held pepper keeps a database
 * leak from becoming a code list. Long bearer secrets (session tokens, API
 * keys) keep using plain SHA-256 from lib/validate.
 *
 * The pepper derives from SESSION_SECRET, which every environment already
 * holds, with a per-kind domain separator in the signed message, so one
 * stored secret serves every kind without cross-kind collisions. */

export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type CodeKind = "invite-code" | "email-code" | "recovery-code";

/** HMAC of a short code, stored in place of the code itself. Fails closed
 *  when the pepper secret is not configured. */
export async function codeHmac(
  env: { SESSION_SECRET?: string },
  kind: CodeKind,
  value: string
): Promise<string> {
  const secret = env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  return hmacSha256Hex(secret, `brimwood/${kind}/v1:${value}`);
}
