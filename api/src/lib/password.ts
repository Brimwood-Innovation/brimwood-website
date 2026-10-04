/* Password hashing (Phase D1): PBKDF2-HMAC-SHA256 via Web Crypto.
 * 600k iterations per OWASP 2023, 32-byte random salt, 32-byte key.
 * Hex-encoded for D1 TEXT columns. Never log passwords. */

const ITERATIONS = 600_000;
const SALT_BYTES = 32;
const KEY_BYTES = 32;

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    baseKey,
    KEY_BYTES * 8
  );
  return toHex(bits);
}

/** Hash a new password. Returns hex-encoded {hash, salt}. */
export async function hashPassword(
  password: string,
  iterations = ITERATIONS
): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, iterations);
  return { hash, salt: toHex(salt) };
}

/** Verify a password against stored hex salt/hash. Constant-time compare. */
export async function verifyPassword(
  password: string,
  saltHex: string,
  hashHex: string,
  iterations = ITERATIONS
): Promise<boolean> {
  try {
    const salt = fromHex(saltHex);
    if (salt.length !== SALT_BYTES) return false;
    const candidate = await derive(password, salt, iterations);
    // safeEqual is imported lazily to avoid cycles; inline the constant-time
    // compare here since this module is standalone.
    if (candidate.length !== hashHex.length) return false;
    let diff = 0;
    for (let i = 0; i < candidate.length; i++) {
      diff |= candidate.charCodeAt(i) ^ hashHex.charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}

/** Password policy: min 12 chars, mixed case, at least one digit.
 * Returns a human-readable error (Canadian spelling) or null if valid. */
export function validatePassword(password: string): string | null {
  if (typeof password !== "string" || password.length < 12) {
    return "Password must be at least 12 characters long.";
  }
  if (password.length > 256) {
    return "Password must be no more than 256 characters long.";
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
    return "Password must include both upper-case and lower-case letters.";
  }
  if (!/[0-9]/.test(password)) {
    return "Password must include at least one number.";
  }
  return null;
}
