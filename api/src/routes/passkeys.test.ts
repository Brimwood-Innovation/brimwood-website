/* Passkey sign-in tests (Phase 3 slice 1): registration and
 * authentication against the 0023 tables, driven through the real route
 * with generated P-256 keys and hand-built authenticator responses.
 * Mocks D1 via the programmable handler; no network. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "./passkeys";
import {
  mockEnv,
  memberSession,
  postJSON,
  type MockEnv,
} from "../test/helpers";
import {
  RP_ID,
  EXPECTED_ORIGIN,
  b64urlEncode,
  b64urlDecode,
  sha256,
  concat,
} from "../lib/webauthn";

let env: MockEnv;
let authed: Record<string, string>;
let consumedChallenges: Set<string>;

interface CredEntry {
  credential_id: string;
  user_id: string;
  public_key: Uint8Array;
  sign_count: number;
  revoked_at: string | null;
  nickname: string | null;
  transports: string | null;
  backup_eligible: number;
  backup_state: number;
  created_at: string;
  last_used_at: string | null;
}

let credentials: Map<string, CredEntry>;

/* ---------- tiny CBOR encoder (tests only) ---------- */

function encLen(major: number, len: number): Uint8Array {
  if (len < 24) return Uint8Array.of((major << 5) | len);
  if (len < 256) return Uint8Array.of((major << 5) | 24, len);
  return Uint8Array.of((major << 5) | 25, (len >> 8) & 0xff, len & 0xff);
}
function cborInt(n: number): Uint8Array {
  return n >= 0 ? encLen(0, n) : encLen(1, -1 - n);
}
function cborBytes(b: Uint8Array): Uint8Array {
  return concat(encLen(2, b.length), b);
}
function cborText(s: string): Uint8Array {
  const b = new TextEncoder().encode(s);
  return concat(encLen(3, b.length), b);
}
function cborMap(pairs: [Uint8Array, Uint8Array][]): Uint8Array {
  return concat(encLen(5, pairs.length), ...pairs.flat());
}

function coseKey(xB64: string, yB64: string): Uint8Array {
  return cborMap([
    [cborInt(1), cborInt(2)],
    [cborInt(3), cborInt(-7)],
    [cborInt(-1), cborInt(1)],
    [cborInt(-2), cborBytes(b64urlDecode(xB64))],
    [cborInt(-3), cborBytes(b64urlDecode(yB64))],
  ]);
}

async function buildAuthData(
  flags: number,
  signCount: number,
  credId: Uint8Array | null,
  cose: Uint8Array | null
): Promise<Uint8Array> {
  const rpIdHash = await sha256(new TextEncoder().encode(RP_ID));
  const head = new Uint8Array(37);
  head.set(rpIdHash, 0);
  head[32] = flags;
  head[33] = (signCount >>> 24) & 0xff;
  head[34] = (signCount >>> 16) & 0xff;
  head[35] = (signCount >>> 8) & 0xff;
  head[36] = signCount & 0xff;
  if (!credId || !cose) return head;
  const tail = new Uint8Array(16 + 2 + credId.length + cose.length);
  tail[16] = (credId.length >> 8) & 0xff;
  tail[17] = credId.length & 0xff;
  tail.set(credId, 18);
  tail.set(cose, 18 + credId.length);
  return concat(head, tail);
}

function clientData(type: string, challenge: string, origin = EXPECTED_ORIGIN): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ type, challenge, origin }));
}

function rawToDer(raw: Uint8Array): Uint8Array {
  const pad = (part: Uint8Array): Uint8Array =>
    part[0] & 0x80 ? concat(Uint8Array.of(0), part) : part;
  const r = pad(raw.slice(0, 32));
  const s = pad(raw.slice(32, 64));
  const body = concat(Uint8Array.of(0x02, r.length), r, Uint8Array.of(0x02, s.length), s);
  return concat(Uint8Array.of(0x30, body.length), body);
}

async function genKey(): Promise<{
  privateKey: CryptoKey;
  x: string;
  y: string;
}> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as unknown as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as {
    x?: string;
    y?: string;
  };
  return { privateKey: pair.privateKey, x: jwk.x!, y: jwk.y! };
}

async function sign(privateKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data as BufferSource);
  return rawToDer(new Uint8Array(sig));
}

function randomId(): { bytes: Uint8Array; b64: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return { bytes, b64: b64urlEncode(bytes) };
}

/* ---------- mock D1 wiring ---------- */

function installHandler() {
  const prev = env.DB.handler;
  env.DB.handler = (sql, params) => {
    // Run-side effects: challenge consumption, credential lifecycle.
    if (/^\s*delete\s+from\s+webauthn_challenges/i.test(sql)) {
      consumedChallenges.add(params[0] as string);
      return { changes: 1 };
    }
    if (/^\s*insert\s+into\s+webauthn_credentials/i.test(sql)) {
      const [id, userId, , publicKey, signCount, aaguid, transports, be, bs, nickname] =
        params as [string, string, string, Uint8Array, number, string | null, string | null, number, number, string | null];
      credentials.set(id, {
        credential_id: id,
        user_id: userId,
        public_key: publicKey,
        sign_count: signCount,
        revoked_at: null,
        nickname,
        transports,
        backup_eligible: be,
        backup_state: bs,
        created_at: new Date(Date.now()).toISOString(),
        last_used_at: null,
      });
      return { changes: 1 };
    }
    if (/^\s*update\s+webauthn_credentials\s+set\s+sign_count/i.test(sql)) {
      const [count, used, id] = params as [number, string, string];
      const c = credentials.get(id);
      if (c) {
        c.sign_count = count;
        c.last_used_at = used;
      }
      return { changes: 1 };
    }
    if (/^\s*update\s+webauthn_credentials\s+set\s+last_used_at/i.test(sql)) {
      const [used, id] = params as [string, string];
      const c = credentials.get(id);
      if (c) c.last_used_at = used;
      return { changes: 1 };
    }
    if (/^\s*update\s+webauthn_credentials\s+set\s+revoked_at/i.test(sql)) {
      const [revoked, id] = params as [string, string];
      const c = credentials.get(id);
      if (c) c.revoked_at = revoked;
      return { changes: 1 };
    }
    // Reads.
    if (/from\s+users/i.test(sql)) {
      return {
        row: { id: "member-1", email: "member@example.com", name: "Test Member", role: "member", status: "active" },
      };
    }
    if (/from\s+webauthn_challenges/i.test(sql)) {
      const [challenge, kind] = params as [string, string];
      const rows = env.DB.inserts.get("webauthn_challenges") || [];
      const row = rows.find(
        (r) => r.challenge === challenge && r.kind === kind && !consumedChallenges.has(r.id as string)
      );
      if (!row) return { row: null };
      return { row: { id: row.id, user_id: row.user_id, expires_at: row.expires_at } };
    }
    if (/from\s+webauthn_user_handles/i.test(sql)) {
      const rows = env.DB.inserts.get("webauthn_user_handles") || [];
      const row = rows.find((r) => r.user_id === params[0]);
      return { row: row ? { user_handle: row.user_handle } : null };
    }
    if (/from\s+webauthn_credentials/i.test(sql)) {
      if (/credential_id\s*=\s*\?/i.test(sql)) {
        const c = credentials.get(params[0] as string);
        if (!c || c.revoked_at) return { row: null };
        return {
          row: {
            credential_id: c.credential_id,
            user_id: c.user_id,
            public_key: c.public_key,
            sign_count: c.sign_count,
          },
        };
      }
      const live = [...credentials.values()].filter(
        (c) => c.user_id === params[0] && !c.revoked_at
      );
      return {
        results: live.map((c) => ({
          credential_id: c.credential_id,
          nickname: c.nickname,
          created_at: c.created_at,
          last_used_at: c.last_used_at,
          transports: c.transports,
          backup_eligible: c.backup_eligible,
          backup_state: c.backup_state,
        })),
      };
    }
    return prev?.(sql, params);
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
  env = mockEnv();
  credentials = new Map();
  consumedChallenges = new Set();
  installHandler();
  authed = memberSession(env, "member-1");
});

afterEach(() => {
  vi.useRealTimers();
});

async function registerOptions() {
  const res = await postJSON(app, "/register/options", {}, env, authed);
  const body = (await res.json()) as { ok: boolean; options: { challenge: string } };
  expect(res.status).toBe(200);
  return body.options.challenge;
}

async function registerCredential(
  key: { privateKey: CryptoKey; x: string; y: string },
  credId: { bytes: Uint8Array; b64: string },
  challenge: string,
  overrides: { origin?: string; fmt?: string; nickname?: string } = {}
): Promise<Response> {
  const cose = coseKey(key.x, key.y);
  const authData = await buildAuthData(0x45, 0, credId.bytes, cose);
  const attestation = cborMap([
    [cborText("fmt"), cborText(overrides.fmt ?? "none")],
    [cborText("attStmt"), cborMap([])],
    [cborText("authData"), cborBytes(authData)],
  ]);
  return postJSON(
    app,
    "/register/verify",
    {
      id: credId.b64,
      rawId: credId.b64,
      type: "public-key",
      nickname: overrides.nickname,
      response: {
        clientDataJSON: b64urlEncode(clientData("webauthn.create", challenge, overrides.origin)),
        attestationObject: b64urlEncode(attestation),
        transports: ["internal"],
      },
    },
    env,
    authed
  );
}

/** Register one credential end to end; returns its id and key. */
async function seedCredential(nickname?: string) {
  const key = await genKey();
  const credId = randomId();
  const challenge = await registerOptions();
  const res = await registerCredential(key, credId, challenge, { nickname });
  expect(res.status).toBe(200);
  return { key, credId };
}

async function authenticateOptions(): Promise<string> {
  const res = await postJSON(app, "/authenticate/options", {}, env);
  const body = (await res.json()) as { ok: boolean; options: { challenge: string } };
  expect(res.status).toBe(200);
  return body.options.challenge;
}

function handleB64(): string {
  const rows = env.DB.inserts.get("webauthn_user_handles") || [];
  const row = rows.find((r) => r.user_id === "member-1");
  return b64urlEncode(row!.user_handle as Uint8Array);
}

async function authenticateVerify(
  key: { privateKey: CryptoKey },
  credId: { bytes: Uint8Array; b64: string },
  challenge: string,
  signCount: number,
  overrides: { origin?: string; userHandle?: string; tamperSig?: boolean } = {}
): Promise<Response> {
  const authData = await buildAuthData(0x05, signCount, null, null);
  const cd = clientData("webauthn.get", challenge, overrides.origin);
  let sig = await sign(key.privateKey, concat(authData, await sha256(cd)));
  if (overrides.tamperSig) {
    sig = new Uint8Array(sig);
    sig[sig.length - 1] ^= 0x01;
  }
  return postJSON(app, "/authenticate/verify", {
    id: credId.b64,
    rawId: credId.b64,
    type: "public-key",
    response: {
      clientDataJSON: b64urlEncode(cd),
      authenticatorData: b64urlEncode(authData),
      signature: b64urlEncode(sig),
      userHandle: overrides.userHandle ?? handleB64(),
    },
  }, env);
}

/* ---------- registration ---------- */

describe("register", () => {
  it("options returns a none-attestation creation challenge for the member", async () => {
    const res = await postJSON(app, "/register/options", {}, env, authed);
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.options.rp.id).toBe("brimwoodinnovation.com");
    expect(body.options.attestation).toBe("none");
    expect(body.options.authenticatorSelection.residentKey).toBe("required");
    expect(body.options.authenticatorSelection.userVerification).toBe("required");
    expect(body.options.user.name).toBe("member@example.com");
    const challenges = env.DB.inserts.get("webauthn_challenges") || [];
    expect(challenges).toHaveLength(1);
    expect(challenges[0].kind).toBe("register");
    expect(challenges[0].user_id).toBe("member-1");
    const handles = env.DB.inserts.get("webauthn_user_handles") || [];
    expect(handles).toHaveLength(1);
  });

  it("requires a session", async () => {
    const res = await postJSON(app, "/register/options", {}, env);
    expect(res.status).toBe(401);
  });

  it("verify stores the credential with its COSE key and nickname", async () => {
    const key = await genKey();
    const credId = randomId();
    const challenge = await registerOptions();
    const res = await registerCredential(key, credId, challenge, { nickname: "Laptop" });
    expect(res.status).toBe(200);
    const stored = credentials.get(credId.b64);
    expect(stored).toBeDefined();
    expect(stored!.user_id).toBe("member-1");
    expect(stored!.nickname).toBe("Laptop");
    expect(stored!.sign_count).toBe(0);
    expect(stored!.backup_eligible).toBe(0);
  });

  it("rejects a registration from the wrong origin", async () => {
    const key = await genKey();
    const credId = randomId();
    const challenge = await registerOptions();
    const res = await registerCredential(key, credId, challenge, {
      origin: "https://evil.example",
    });
    expect(res.status).toBe(401);
    expect(credentials.size).toBe(0);
  });

  it("rejects a replayed registration challenge", async () => {
    const key = await genKey();
    const credId = randomId();
    const challenge = await registerOptions();
    const first = await registerCredential(key, credId, challenge);
    expect(first.status).toBe(200);
    const replay = await registerCredential(key, randomId(), challenge);
    expect(replay.status).toBe(401);
  });

  it("rejects non-none attestation", async () => {
    const key = await genKey();
    const credId = randomId();
    const challenge = await registerOptions();
    const res = await registerCredential(key, credId, challenge, { fmt: "packed" });
    expect(res.status).toBe(401);
    expect(credentials.size).toBe(0);
  });

  it("rejects a credential id that is already registered", async () => {
    const { key, credId } = await seedCredential();
    const challenge = await registerOptions();
    const res = await registerCredential(key, credId, challenge);
    expect(res.status).toBe(409);
  });
});

/* ---------- authentication ---------- */

describe("authenticate", () => {
  it("options returns an assertion challenge for the relying party", async () => {
    const res = await postJSON(app, "/authenticate/options", {}, env);
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.options.rpId).toBe("brimwoodinnovation.com");
    expect(body.options.userVerification).toBe("required");
    const challenges = env.DB.inserts.get("webauthn_challenges") || [];
    expect(challenges[0].kind).toBe("authenticate");
    expect(challenges[0].user_id).toBeNull();
  });

  it("verify signs the member in with a passkey session", async () => {
    const { key, credId } = await seedCredential();
    const challenge = await authenticateOptions();
    const res = await authenticateVerify(key, credId, challenge, 1);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") || "";
    expect(cookie).toContain("__Host-brimwood-sess=");
    const sessions = [...env.DB.sessionStore.values()];
    const session = sessions.find(
      (s) => s.user_id === "member-1" && (s.amr || "").includes("passkey")
    );
    expect(session).toBeDefined();
    expect(JSON.parse(session!.amr || "[]")).toContain("passkey");
    expect(credentials.get(credId.b64)!.sign_count).toBe(1);
  });

  it("rejects a bad signature", async () => {
    const { key, credId } = await seedCredential();
    const challenge = await authenticateOptions();
    const res = await authenticateVerify(key, credId, challenge, 1, { tamperSig: true });
    expect(res.status).toBe(401);
  });

  it("rejects a counter that does not rise", async () => {
    const { key, credId } = await seedCredential();
    const first = await authenticateOptions();
    expect((await authenticateVerify(key, credId, first, 5)).status).toBe(200);
    const second = await authenticateOptions();
    const replay = await authenticateVerify(key, credId, second, 5);
    expect(replay.status).toBe(401);
    const third = await authenticateOptions();
    const older = await authenticateVerify(key, credId, third, 3);
    expect(older.status).toBe(401);
  });

  it("accepts a later counter and rejects a replayed challenge", async () => {
    const { key, credId } = await seedCredential();
    const challenge = await authenticateOptions();
    expect((await authenticateVerify(key, credId, challenge, 2)).status).toBe(200);
    const replay = await authenticateVerify(key, credId, challenge, 3);
    expect(replay.status).toBe(401);
  });

  it("rejects an unknown credential and a wrong user handle", async () => {
    const { key, credId } = await seedCredential();
    const challenge = await authenticateOptions();
    const unknown = await authenticateVerify(key, randomId(), challenge, 1);
    expect(unknown.status).toBe(401);
    const challenge2 = await authenticateOptions();
    const wrongHandle = await authenticateVerify(key, credId, challenge2, 1, {
      userHandle: b64urlEncode(crypto.getRandomValues(new Uint8Array(32))),
    });
    expect(wrongHandle.status).toBe(401);
  });

  it("rejects the wrong origin", async () => {
    const { key, credId } = await seedCredential();
    const challenge = await authenticateOptions();
    const res = await authenticateVerify(key, credId, challenge, 1, {
      origin: "https://evil.example",
    });
    expect(res.status).toBe(401);
  });
});

/* ---------- manage ---------- */

describe("manage", () => {
  it("lists live credentials and revokes one of two, but not the last", async () => {
    const first = await seedCredential("Laptop");
    const second = await seedCredential("Phone");
    const list = await app.request("/", { headers: authed }, env as any);
    const listed = (await list.json()) as any;
    expect(listed.credentials).toHaveLength(2);
    expect(listed.credentials.map((c: any) => c.nickname)).toEqual(["Laptop", "Phone"]);
    const del = await app.request(`/${second.credId.b64}`, { method: "DELETE", headers: authed }, env as any);
    expect(del.status).toBe(200);
    const list2res = await app.request("/", { headers: authed }, env as any);
    const list2 = (await list2res.json()) as any;
    expect(list2.credentials).toHaveLength(1);
    const last = await app.request(`/${first.credId.b64}`, { method: "DELETE", headers: authed }, env as any);
    expect(last.status).toBe(400);
    const unknown = await app.request("/nope", { method: "DELETE", headers: authed }, env as any);
    expect(unknown.status).toBe(404);
  });

  it("requires a session to list", async () => {
    const res = await app.request("/", {}, env as any);
    expect(res.status).toBe(401);
  });
});
