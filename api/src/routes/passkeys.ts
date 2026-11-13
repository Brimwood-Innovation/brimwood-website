/* Passkey sign-in (Phase 3 slice 1, SCHEMA section 7 item 5 / S8).
 * The tables already exist in migration 0023 (webauthn_credentials,
 * webauthn_user_handles, webauthn_challenges); this file is the API that
 * was missing, plus the session it creates. Email codes stay as the
 * fallback: a member with no passkey, or a device without one, signs in
 * with a code exactly as before.
 *
 * POST /api/passkeys/register/options   (signed in)  -> creation options
 * POST /api/passkeys/register/verify    (signed in)  -> store the credential
 * POST /api/passkeys/authenticate/options            -> assertion options
 * POST /api/passkeys/authenticate/verify             -> session, amr passkey
 * GET  /api/passkeys                    (signed in)  -> own live credentials
 * DELETE /api/passkeys/:id             (signed in)  -> revoke one credential
 *
 * Security notes, following the email-code pattern in ./auth.ts:
 * - challenges are single-use (SELECT, then DELETE that must change a
 *   row, so a racer replaying the same challenge fails closed) and
 *   4-minute lived, inside the table CHECK with clock-skew room.
 * - verify failures are generic: a wrong origin, a replayed challenge,
 *   a bad signature, and an unknown credential all answer the same way.
 * - the last live credential cannot be revoked here (the 0024 trigger
 *   enforces the same rule in the database); removing it would lock the
 *   member out of passkey sign-in entirely.
 * - rp_id is pinned by the table CHECK to brimwoodinnovation.com, so
 *   the browser flow works on the production domain only; see
 *   ../lib/webauthn.ts for the deployment note. */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { cleanStr, clientIp } from "../lib/validate";
import { checkRateLimitD1 } from "../lib/ratelimit-d1";
import {
  setSessionCookie,
  createSession,
  requireUser,
  summarizeUa,
  cfCity,
  type Session,
} from "../lib/auth";
import {
  RP_ID,
  RP_NAME,
  EXPECTED_ORIGIN,
  CHALLENGE_TTL_MS,
  isB64Url,
  b64urlEncode,
  b64urlDecode,
  sha256,
  bytesEqual,
  parseClientData,
  parseAuthData,
  parseAttestationNone,
  coseP256Coords,
  verifyAssertionSignature,
} from "../lib/webauthn";

type Env = Bindings;

const app = new Hono<{ Bindings: Env; Variables: { user: Session } }>();

const GENERIC_REGISTER_FAIL = "Invalid passkey registration.";
const GENERIC_AUTH_FAIL = "Invalid passkey sign-in.";
const RATE_MSG = "Too many requests. Please try again later.";

function fail(c: any, message: string, status: number) {
  return c.json({ ok: false, error: message }, status);
}

/** D1 returns BLOB columns as ArrayBuffer; tests hand back Uint8Array. */
function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return new Uint8Array(v as number[]);
  throw new Error("not bytes");
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomChallenge(): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

function randomHandle(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

async function jsonBody(c: any): Promise<Record<string, unknown> | null> {
  try {
    const data = await c.req.json();
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return null;
}

function responseOf(data: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const r = data[key];
  if (typeof r === "object" && r !== null && !Array.isArray(r)) {
    return r as Record<string, unknown>;
  }
  return null;
}

function b64Field(data: Record<string, unknown>, key: string): string | null {
  const v = data[key];
  return isB64Url(v) ? (v as string) : null;
}

interface ChallengeRow {
  id: string;
  user_id: string | null;
  expires_at: string;
}

/** Insert a challenge and return its base64url text. */
async function newChallenge(DB: any, userId: string | null, kind: string): Promise<string> {
  const challenge = randomChallenge();
  await DB.prepare(
    `INSERT INTO webauthn_challenges (id, challenge, user_id, kind, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      challenge,
      userId,
      kind,
      new Date(Date.now() + CHALLENGE_TTL_MS).toISOString()
    )
    .run();
  return challenge;
}

/** Consume a challenge: it must exist, be unexpired, and delete exactly
 * once. Returns the row, or null when the challenge is unusable. */
async function consumeChallenge(
  DB: any,
  challenge: string,
  kind: string
): Promise<ChallengeRow | null> {
  const row = (await DB.prepare(
    `SELECT id, user_id, expires_at FROM webauthn_challenges
     WHERE challenge = ? AND kind = ?`
  )
    .bind(challenge, kind)
    .first()) as ChallengeRow | null;
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    await DB.prepare(`DELETE FROM webauthn_challenges WHERE id = ?`).bind(row.id).run();
    return null;
  }
  const deleted = await DB.prepare(`DELETE FROM webauthn_challenges WHERE id = ?`)
    .bind(row.id)
    .run();
  if (deleted.meta.changes === 0) return null;
  return row;
}

/** The member's WebAuthn user handle, creating it on first use. */
async function getOrCreateHandle(DB: any, userId: string): Promise<Uint8Array> {
  const row = (await DB.prepare(
    `SELECT user_handle FROM webauthn_user_handles WHERE user_id = ?`
  )
    .bind(userId)
    .first()) as { user_handle: unknown } | null;
  if (row) return toBytes(row.user_handle);
  const handle = randomHandle();
  await DB.prepare(
    `INSERT INTO webauthn_user_handles (user_id, user_handle) VALUES (?, ?)`
  )
    .bind(userId, handle)
    .run();
  return handle;
}

async function liveCredentialIds(DB: any, userId: string): Promise<string[]> {
  const { results } = (await DB.prepare(
    `SELECT credential_id FROM webauthn_credentials
     WHERE user_id = ? AND revoked_at IS NULL`
  )
    .bind(userId)
    .all()) as { results: { credential_id: string }[] };
  return results.map((r) => r.credential_id);
}

/* ---------------- Registration ---------------- */

app.post("/register/options", requireUser, async (c) => {
  const user = c.get("user") as Session;
  const DB = c.env.DB;
  if (!(await checkRateLimitD1(DB, "pk-reg-opt:" + user.userId, 10, 900))) {
    return fail(c, RATE_MSG, 429);
  }
  const member = (await DB.prepare(
    `SELECT id, email, name FROM users WHERE id = ? AND status = 'active'`
  )
    .bind(user.userId)
    .first()) as { id: string; email: string; name: string } | null;
  if (!member) return fail(c, "Sign in required.", 401);
  const handle = await getOrCreateHandle(DB, user.userId);
  const challenge = await newChallenge(DB, user.userId, "register");
  const exclude = (await liveCredentialIds(DB, user.userId)).map((id) => ({
    type: "public-key",
    id,
  }));
  return c.json({
    ok: true,
    options: {
      rp: { name: RP_NAME, id: RP_ID },
      user: {
        id: b64urlEncode(handle),
        name: member.email,
        displayName: member.name,
      },
      challenge,
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      timeout: 60_000,
      attestation: "none",
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
      excludeCredentials: exclude,
    },
  });
});

app.post("/register/verify", requireUser, async (c) => {
  const user = c.get("user") as Session;
  const DB = c.env.DB;
  if (!(await checkRateLimitD1(DB, "pk-reg-ver:" + user.userId, 10, 900))) {
    return fail(c, RATE_MSG, 429);
  }
  const data = await jsonBody(c);
  const response = data ? responseOf(data, "response") : null;
  const id = data ? b64Field(data, "id") : null;
  if (!data || !response || !id) return fail(c, GENERIC_REGISTER_FAIL, 400);
  const rawId = data.rawId;
  if (rawId !== undefined && rawId !== id) return fail(c, GENERIC_REGISTER_FAIL, 400);
  if (data.type !== undefined && data.type !== "public-key") {
    return fail(c, GENERIC_REGISTER_FAIL, 400);
  }
  try {
    const clientDataBytes = b64urlDecode(b64Field(response, "clientDataJSON") ?? "");
    const attestationBytes = b64urlDecode(b64Field(response, "attestationObject") ?? "");
    const clientData = parseClientData(clientDataBytes);
    if (clientData.type !== "webauthn.create") return fail(c, GENERIC_REGISTER_FAIL, 401);
    if (clientData.origin !== EXPECTED_ORIGIN) return fail(c, GENERIC_REGISTER_FAIL, 401);
    const challenge = await consumeChallenge(DB, clientData.challenge, "register");
    if (!challenge || challenge.user_id !== user.userId) {
      return fail(c, GENERIC_REGISTER_FAIL, 401);
    }
    const { authData } = parseAttestationNone(attestationBytes);
    if (!authData.flags.at || !authData.credentialId || !authData.coseKeyBytes) {
      return fail(c, GENERIC_REGISTER_FAIL, 401);
    }
    if (!bytesEqual(authData.rpIdHash, await sha256(new TextEncoder().encode(RP_ID)))) {
      return fail(c, GENERIC_REGISTER_FAIL, 401);
    }
    if (!authData.flags.up || !authData.flags.uv) {
      return fail(c, GENERIC_REGISTER_FAIL, 401);
    }
    if (b64urlEncode(authData.credentialId) !== id) {
      return fail(c, GENERIC_REGISTER_FAIL, 401);
    }
    // Validates the COSE key shape (EC2, ES256, P-256, 32-byte x and y).
    coseP256Coords(authData.coseKeyBytes);
    const existing = (await DB.prepare(
      `SELECT credential_id FROM webauthn_credentials WHERE credential_id = ?`
    )
      .bind(id)
      .first()) as { credential_id: string } | null;
    if (existing) return fail(c, "This passkey is already registered.", 409);
    const nickname = cleanStr(data.nickname, 60) || null;
    let transports: string | null = null;
    if (Array.isArray(response.transports)) {
      const list = response.transports.filter((t) => typeof t === "string").slice(0, 8);
      transports = JSON.stringify(list);
    }
    await getOrCreateHandle(DB, user.userId);
    await DB.prepare(
      `INSERT INTO webauthn_credentials
         (credential_id, user_id, rp_id, public_key, sign_count, aaguid,
          transports, backup_eligible, backup_state, nickname)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        user.userId,
        RP_ID,
        authData.coseKeyBytes,
        authData.signCount,
        authData.aaguid ? hex(authData.aaguid) : null,
        transports,
        authData.flags.be ? 1 : 0,
        authData.flags.bs ? 1 : 0,
        nickname
      )
      .run();
    return c.json({ ok: true });
  } catch {
    return fail(c, GENERIC_REGISTER_FAIL, 401);
  }
});

/* ---------------- Authentication ---------------- */

app.post("/authenticate/options", async (c) => {
  const DB = c.env.DB;
  if (!(await checkRateLimitD1(DB, "pk-auth-opt:" + clientIp(c.req.raw), 10, 900))) {
    return fail(c, RATE_MSG, 429);
  }
  const challenge = await newChallenge(DB, null, "authenticate");
  return c.json({
    ok: true,
    options: {
      challenge,
      timeout: 60_000,
      rpId: RP_ID,
      userVerification: "required",
    },
  });
});

app.post("/authenticate/verify", async (c) => {
  const DB = c.env.DB;
  if (!(await checkRateLimitD1(DB, "pk-auth-ver:" + clientIp(c.req.raw), 10, 900))) {
    return fail(c, RATE_MSG, 429);
  }
  const data = await jsonBody(c);
  const response = data ? responseOf(data, "response") : null;
  const id = data ? b64Field(data, "id") : null;
  if (!data || !response || !id) return fail(c, GENERIC_AUTH_FAIL, 400);
  const rawId = data.rawId;
  if (rawId !== undefined && rawId !== id) return fail(c, GENERIC_AUTH_FAIL, 400);
  if (data.type !== undefined && data.type !== "public-key") {
    return fail(c, GENERIC_AUTH_FAIL, 400);
  }
  try {
    const clientDataBytes = b64urlDecode(b64Field(response, "clientDataJSON") ?? "");
    const authenticatorData = b64urlDecode(b64Field(response, "authenticatorData") ?? "");
    const signature = b64urlDecode(b64Field(response, "signature") ?? "");
    const userHandleB64 = b64Field(response, "userHandle");
    const clientData = parseClientData(clientDataBytes);
    if (clientData.type !== "webauthn.get") return fail(c, GENERIC_AUTH_FAIL, 401);
    if (clientData.origin !== EXPECTED_ORIGIN) return fail(c, GENERIC_AUTH_FAIL, 401);
    const challenge = await consumeChallenge(DB, clientData.challenge, "authenticate");
    if (!challenge || challenge.user_id !== null) {
      return fail(c, GENERIC_AUTH_FAIL, 401);
    }
    const credential = (await DB.prepare(
      `SELECT credential_id, user_id, public_key, sign_count
       FROM webauthn_credentials WHERE credential_id = ? AND revoked_at IS NULL`
    )
      .bind(id)
      .first()) as {
      credential_id: string;
      user_id: string;
      public_key: unknown;
      sign_count: number;
    } | null;
    if (!credential) return fail(c, GENERIC_AUTH_FAIL, 401);
    const handleRow = (await DB.prepare(
      `SELECT user_handle FROM webauthn_user_handles WHERE user_id = ?`
    )
      .bind(credential.user_id)
      .first()) as { user_handle: unknown } | null;
    if (!handleRow || !userHandleB64) return fail(c, GENERIC_AUTH_FAIL, 401);
    if (b64urlEncode(toBytes(handleRow.user_handle)) !== userHandleB64) {
      return fail(c, GENERIC_AUTH_FAIL, 401);
    }
    const authData = parseAuthData(authenticatorData);
    if (!bytesEqual(authData.rpIdHash, await sha256(new TextEncoder().encode(RP_ID)))) {
      return fail(c, GENERIC_AUTH_FAIL, 401);
    }
    if (!authData.flags.up || !authData.flags.uv || authData.flags.at) {
      return fail(c, GENERIC_AUTH_FAIL, 401);
    }
    const coords = coseP256Coords(toBytes(credential.public_key));
    const signatureOk = await verifyAssertionSignature(
      coords,
      authenticatorData,
      clientDataBytes,
      signature
    );
    if (!signatureOk) return fail(c, GENERIC_AUTH_FAIL, 401);
    // Counter: a zero counter means the authenticator does not track one,
    // so it is accepted without enforcement; any other value must rise
    // above the stored one, or the credential may be cloned.
    if (authData.signCount !== 0) {
      if (credential.sign_count > 0 && authData.signCount <= credential.sign_count) {
        return fail(c, GENERIC_AUTH_FAIL, 401);
      }
      await DB.prepare(
        `UPDATE webauthn_credentials SET sign_count = ?, last_used_at = ?
         WHERE credential_id = ?`
      )
        .bind(authData.signCount, new Date(Date.now()).toISOString(), id)
        .run();
    } else {
      await DB.prepare(
        `UPDATE webauthn_credentials SET last_used_at = ? WHERE credential_id = ?`
      )
        .bind(new Date(Date.now()).toISOString(), id)
        .run();
    }
    const member = (await DB.prepare(
      `SELECT id, role FROM users WHERE id = ? AND status = 'active'`
    )
      .bind(credential.user_id)
      .first()) as { id: string; role: string } | null;
    if (!member) return fail(c, GENERIC_AUTH_FAIL, 401);
    const token = await createSession(c.env, member.id, member.role, {
      amr: ["passkey"],
      uaSummary: summarizeUa(c.req.header("user-agent")),
      city: cfCity(c),
    });
    setSessionCookie(c, token);
    return c.json({ ok: true });
  } catch {
    return fail(c, GENERIC_AUTH_FAIL, 401);
  }
});

/* ---------------- Manage ---------------- */

app.get("/", requireUser, async (c) => {
  const user = c.get("user") as Session;
  const DB = c.env.DB;
  const { results } = (await DB.prepare(
    `SELECT credential_id, nickname, created_at, last_used_at, transports,
            backup_eligible, backup_state
     FROM webauthn_credentials WHERE user_id = ? AND revoked_at IS NULL
     ORDER BY created_at ASC`
  )
    .bind(user.userId)
    .all()) as {
    results: {
      credential_id: string;
      nickname: string | null;
      created_at: string;
      last_used_at: string | null;
      transports: string | null;
      backup_eligible: number;
      backup_state: number;
    }[];
  };
  return c.json({
    ok: true,
    credentials: results.map((r) => ({
      id: r.credential_id,
      nickname: r.nickname,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      transports: r.transports ? (JSON.parse(r.transports) as string[]) : [],
      backupEligible: r.backup_eligible === 1,
      backupState: r.backup_state === 1,
    })),
  });
});

app.delete("/:id", requireUser, async (c) => {
  const user = c.get("user") as Session;
  const DB = c.env.DB;
  if (!(await checkRateLimitD1(DB, "pk-del:" + user.userId, 10, 900))) {
    return fail(c, RATE_MSG, 429);
  }
  const id = c.req.param("id");
  if (!isB64Url(id)) return fail(c, "Unknown passkey.", 404);
  const live = await liveCredentialIds(DB, user.userId);
  if (!live.includes(id)) return fail(c, "Unknown passkey.", 404);
  if (live.length <= 1) {
    return fail(c, "Cannot remove your last passkey. Add another first.", 400);
  }
  await DB.prepare(
    `UPDATE webauthn_credentials SET revoked_at = ?
     WHERE credential_id = ? AND user_id = ? AND revoked_at IS NULL`
  )
    .bind(new Date(Date.now()).toISOString(), id, user.userId)
    .run();
  return c.json({ ok: true });
});

export default app;
