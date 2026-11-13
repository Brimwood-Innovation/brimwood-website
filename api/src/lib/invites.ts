/* Invite codes (SCHEMA C28, S2). One visible format: BRIM-XXXX-XXXX, eight
 * symbols from the 31-symbol alphabet (no 0, O, 1, I, L, so codes survive
 * being read aloud). The database stores only the HMAC of the code
 * (lib/hmac), so the plain code exists exactly once: in the response that
 * creates it. */
import { codeHmac } from "./hmac";

export const INVITE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** CSPRNG code with rejection sampling, so every symbol is equally likely. */
export function generateInviteCode(): string {
  const out: string[] = [];
  // 248 is the largest multiple of 31 below 256; bytes at or above it would
  // bias the first symbols, so they are discarded.
  const limit = 256 - (256 % INVITE_ALPHABET.length);
  while (out.length < 8) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    for (const b of bytes) {
      if (b >= limit) continue;
      out.push(INVITE_ALPHABET[b % INVITE_ALPHABET.length]);
      if (out.length === 8) break;
    }
  }
  return `BRIM-${out.slice(0, 4).join("")}-${out.slice(4).join("")}`;
}

/** The stored form of an invite code. Input is normalized to upper case so
 *  a code typed in lower case still matches. */
export function inviteCodeHmac(
  env: { SESSION_SECRET?: string },
  plainCode: string
): Promise<string> {
  return codeHmac(env, "invite-code", plainCode.toUpperCase());
}
