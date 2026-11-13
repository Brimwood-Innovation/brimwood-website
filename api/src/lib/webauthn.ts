/* WebAuthn (passkey) verification helpers, no D1, no network.
 * Phase 3 slice 1: the passkey tables already exist in migration 0023
 * (webauthn_credentials, webauthn_user_handles, webauthn_challenges);
 * this file supplies the cryptography the routes need, and the routes in
 * ./routes/passkeys.ts supply the storage and the session.
 *
 * Relying party: the schema CHECK pins rp_id to brimwoodinnovation.com,
 * so the browser flow only works on the production domain. On a preview
 * deployment the options endpoints still answer, but the browser refuses
 * a credential whose relying party is not a suffix of the page origin;
 * that is a deployment fact, not a code path, and it is recorded in the
 * loop state. Tests drive this module with generated keys instead.
 *
 * Attestation: the options we issue request attestation "none", and
 * registration accepts only fmt "none". The credential key is still
 * verified structurally (rpIdHash, flags, attested data, COSE key), and
 * the authentication signature is verified cryptographically, so the
 * attestation certificate chain adds nothing here. Anything else fails
 * closed rather than being trusted on its word. */

export const RP_ID = "brimwoodinnovation.com";
export const RP_NAME = "Brimwood Innovation";
export const EXPECTED_ORIGIN = "https://brimwoodinnovation.com";
/* Challenge life: 240 seconds, inside the 300.5 second table CHECK on
 * webauthn_challenges with room for clock skew between the app and D1. */
export const CHALLENGE_TTL_MS = 240_000;

const B64URL = /^[A-Za-z0-9_-]+$/;

export function isB64Url(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 1400 && B64URL.test(v);
}

/** base64url encode, no padding. */
export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url decode. Throws on bad input. */
export function b64urlDecode(s: string): Uint8Array {
  if (!isB64Url(s)) throw new Error("bad base64url");
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return new Uint8Array(buf);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export interface ClientData {
  type: string;
  challenge: string;
  origin: string;
}

/** Parse and validate the shape of clientDataJSON. Throws on bad input. */
export function parseClientData(bytes: Uint8Array): ClientData {
  const text = new TextDecoder().decode(bytes);
  const data: unknown = JSON.parse(text);
  if (typeof data !== "object" || data === null) throw new Error("bad clientData");
  const { type, challenge, origin } = data as Record<string, unknown>;
  if (typeof type !== "string" || typeof challenge !== "string" || typeof origin !== "string") {
    throw new Error("bad clientData fields");
  }
  return { type, challenge, origin };
}

/* ---------------- Minimal CBOR decoder ----------------
 * Only what WebAuthn needs: unsigned/negative ints, byte and text
 * strings, arrays, maps, and the small simple values. Attestation
 * objects and COSE keys use nothing else. */

type CborValue = number | Uint8Array | string | CborValue[] | Map<CborValue, CborValue> | boolean | null;

function cborHead(bytes: Uint8Array, pos: number): { major: number; value: number; next: number } {
  const initial = bytes[pos];
  const major = initial >> 5;
  const info = initial & 0x1f;
  if (info < 24) return { major, value: info, next: pos + 1 };
  if (info === 24) return { major, value: bytes[pos + 1], next: pos + 2 };
  if (info === 25) {
    const v = (bytes[pos + 1] << 8) | bytes[pos + 2];
    return { major, value: v, next: pos + 3 };
  }
  if (info === 26) {
    const v =
      (bytes[pos + 1] * 0x1000000 + bytes[pos + 2] * 0x10000 + bytes[pos + 3] * 0x100 + bytes[pos + 4]) >>>
      0;
    return { major, value: v, next: pos + 5 };
  }
  throw new Error("unsupported CBOR length");
}

export function decodeCbor(bytes: Uint8Array): { value: CborValue; length: number } {
  function decodeAt(pos: number): { value: CborValue; next: number } {
    const { major, value, next } = cborHead(bytes, pos);
    if (major === 0) return { value, next };
    if (major === 1) return { value: -1 - value, next };
    if (major === 2) {
      return { value: bytes.slice(next, next + value), next: next + value };
    }
    if (major === 3) {
      const text = new TextDecoder().decode(bytes.slice(next, next + value));
      return { value: text, next: next + value };
    }
    if (major === 4) {
      const arr: CborValue[] = [];
      let p = next;
      for (let i = 0; i < value; i++) {
        const item = decodeAt(p);
        arr.push(item.value);
        p = item.next;
      }
      return { value: arr, next: p };
    }
    if (major === 5) {
      const map = new Map<CborValue, CborValue>();
      let p = next;
      for (let i = 0; i < value; i++) {
        const k = decodeAt(p);
        const v = decodeAt(k.next);
        map.set(k.value, v.value);
        p = v.next;
      }
      return { value: map, next: p };
    }
    if (major === 7) {
      if (value === 20) return { value: false, next };
      if (value === 21) return { value: true, next };
      if (value === 22) return { value: null, next };
    }
    throw new Error("unsupported CBOR value");
  }
  const { value, next } = decodeAt(0);
  return { value, length: next };
}

export interface AuthData {
  rpIdHash: Uint8Array;
  flags: { up: boolean; uv: boolean; be: boolean; bs: boolean; at: boolean };
  signCount: number;
  aaguid: Uint8Array | null;
  credentialId: Uint8Array | null;
  coseKeyBytes: Uint8Array | null;
}

/** Parse authenticator data. Throws on truncation or bad lengths. */
export function parseAuthData(bytes: Uint8Array): AuthData {
  if (bytes.length < 37) throw new Error("authData too short");
  const rpIdHash = bytes.slice(0, 32);
  const flagByte = bytes[32];
  const signCount =
    (bytes[33] << 24) | (bytes[34] << 16) | (bytes[35] << 8) | bytes[36];
  const flags = {
    up: (flagByte & 0x01) !== 0,
    uv: (flagByte & 0x04) !== 0,
    be: (flagByte & 0x08) !== 0,
    bs: (flagByte & 0x10) !== 0,
    at: (flagByte & 0x40) !== 0,
  };
  if (!flags.at) {
    return { rpIdHash, flags, signCount, aaguid: null, credentialId: null, coseKeyBytes: null };
  }
  if (bytes.length < 55) throw new Error("attested authData too short");
  const aaguid = bytes.slice(37, 53);
  const credIdLen = (bytes[53] << 8) | bytes[54];
  const credStart = 55;
  const credEnd = credStart + credIdLen;
  if (credEnd > bytes.length) throw new Error("credential id overruns authData");
  const credentialId = bytes.slice(credStart, credEnd);
  const coseKeyBytes = bytes.slice(credEnd);
  if (coseKeyBytes.length === 0) throw new Error("missing COSE key");
  return { rpIdHash, flags, signCount, aaguid, credentialId, coseKeyBytes };
}

/** Extract the P-256 x and y coordinates from a COSE EC2 public key. */
export function coseP256Coords(coseKeyBytes: Uint8Array): { x: string; y: string } {
  const { value, length } = decodeCbor(coseKeyBytes);
  if (!(value instanceof Map)) throw new Error("COSE key is not a map");
  if (length !== coseKeyBytes.length) throw new Error("trailing bytes in COSE key");
  const get = (k: number): unknown => value.get(k);
  if (get(1) !== 2) throw new Error("COSE key is not EC2");
  if (get(3) !== -7) throw new Error("COSE key is not ES256");
  if (get(-1) !== 1) throw new Error("COSE curve is not P-256");
  const x = get(-2);
  const y = get(-3);
  if (!(x instanceof Uint8Array) || x.length !== 32) throw new Error("COSE x is not 32 bytes");
  if (!(y instanceof Uint8Array) || y.length !== 32) throw new Error("COSE y is not 32 bytes");
  return { x: b64urlEncode(x), y: b64urlEncode(y) };
}

/** Convert a DER-encoded ECDSA signature to raw r || s (64 bytes). */
export function derToRawSignature(der: Uint8Array): Uint8Array {
  if (der.length < 8 || der[0] !== 0x30) throw new Error("signature is not DER");
  let pos = 2;
  if (der[1] & 0x80) {
    const lenBytes = der[1] & 0x7f;
    if (lenBytes !== 1) throw new Error("unsupported DER length");
    pos = 3;
  }
  const readInt = (): Uint8Array => {
    if (der[pos] !== 0x02) throw new Error("DER integer expected");
    const len = der[pos + 1];
    const raw = der.slice(pos + 2, pos + 2 + len);
    pos += 2 + len;
    // Strip a leading zero added for sign, then left-pad to 32 bytes.
    const stripped = raw.length > 0 && raw[0] === 0 ? raw.slice(1) : raw;
    if (stripped.length > 32) throw new Error("DER integer too long");
    const out = new Uint8Array(32);
    out.set(stripped, 32 - stripped.length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  return concat(r, s);
}

/** Verify an assertion signature over authData || SHA-256(clientDataJSON). */
export async function verifyAssertionSignature(
  jwk: { x: string; y: string },
  authenticatorData: Uint8Array,
  clientDataJson: Uint8Array,
  signatureDer: Uint8Array
): Promise<boolean> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
  } catch {
    return false;
  }
  let raw: Uint8Array;
  try {
    raw = derToRawSignature(signatureDer);
  } catch {
    return false;
  }
  const signed = concat(authenticatorData, await sha256(clientDataJson));
  try {
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      raw as BufferSource,
      signed as BufferSource
    );
  } catch {
    return false;
  }
}

/** Parse an attestation object. Only fmt "none" is accepted. */
export function parseAttestationNone(
  attestationBytes: Uint8Array
): { authData: AuthData } {
  const { value, length } = decodeCbor(attestationBytes);
  if (!(value instanceof Map)) throw new Error("attestation is not a map");
  if (length !== attestationBytes.length) throw new Error("trailing bytes in attestation");
  const fmt = value.get("fmt");
  const attStmt = value.get("attStmt");
  const authDataRaw = value.get("authData");
  if (fmt !== "none") throw new Error("only none attestation is accepted");
  if (!(attStmt instanceof Map) || attStmt.size !== 0) {
    throw new Error("none attestation carries a statement");
  }
  if (!(authDataRaw instanceof Uint8Array)) throw new Error("attestation has no authData");
  const authData = parseAuthData(authDataRaw);
  if (!authData.flags.at || !authData.credentialId || !authData.coseKeyBytes) {
    throw new Error("attestation has no attested credential");
  }
  return { authData };
}
