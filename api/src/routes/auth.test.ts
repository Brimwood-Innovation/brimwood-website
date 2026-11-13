/* Magic-code auth tests (Phase 1 item 6): email codes in D1 auth_email_codes
 * with HMAC storage, atomic guarded attempts, browser binding, supersede,
 * and strict expiry; sessions carry the S6 sign-in context.
 * Mocks D1/KV/fetch, no network. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "./auth";
import { sha256Hex } from "../lib/validate";
import { codeHmac } from "../lib/hmac";
import {
  mockEnv,
  mailStub,
  mailFailStub,
  postJSON,
  type MockEnv,
} from "../test/helpers";

let env: MockEnv;
let restoreFetch: (() => void) | null = null;

beforeEach(() => {
  env = mockEnv();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
});

afterEach(() => {
  if (restoreFetch) {
    restoreFetch();
    restoreFetch = null;
  }
  vi.useRealTimers();
});

const EMAIL = "user@example.com";

/** Seed an active user for the request-code / verify-code lookups. */
function seedActiveUser() {
  const prev = env.DB.handler;
  env.DB.handler = (sql, params) => {
    if (/from\s+users/i.test(sql)) {
      return { row: { id: "user-1", name: "Test User", role: "member", status: "active" } };
    }
    return prev?.(sql, params);
  };
}

/** Seed a live code row in D1 auth_email_codes, mirroring what the
 * request-code route stores (HMAC code, binding hash, 10-minute expiry).
 * Returns the row id and the browser-binding secret (presented in the
 * __Host-brimwood-cbind cookie at verify time). */
async function putCode(
  email: string,
  code: string,
  overrides: { attempts?: number; expiresAt?: number } = {}
) {
  const id = crypto.randomUUID();
  const binding = "bind-" + id;
  const expiresAt = new Date(overrides.expiresAt ?? Date.now() + 600_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO auth_email_codes
       (id, email, user_id, purpose, code_hmac, browser_binding_hash, expires_at, ip_hmac)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      email,
      "user-1",
      "sign_in",
      await codeHmac(env as any, "email-code", code),
      await sha256Hex(binding),
      expiresAt,
      null
    )
    .run();
  if (overrides.attempts !== undefined) env.DB.codeStore.get(id)!.attempts = overrides.attempts;
  return { id, binding };
}

const CBIND = "__Host-brimwood-cbind";

function withBinding(binding: string): Record<string, string> {
  return { cookie: `${CBIND}=${binding}` };
}

describe("POST /verify-code", () => {
  it("rejects an expired code and consumes the row", async () => {
    seedActiveUser();
    const { id, binding } = await putCode(EMAIL, "123456", { expiresAt: Date.now() - 1000 });
    const res = await postJSON(
      app,
      "/verify-code",
      { email: EMAIL, code: "123456" },
      env,
      withBinding(binding)
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/expired/i);
    // Expired rows are consumed (retention keeps the row; the live slot is freed).
    expect(env.DB.codeStore.get(id)!.consumed_at).not.toBeNull();
  });

  it("does not extend the code's life on a failed attempt", async () => {
    seedActiveUser();
    const expiresAt = Date.now() + 600_000;
    const { id, binding } = await putCode(EMAIL, "123456", { expiresAt });
    const res = await postJSON(
      app,
      "/verify-code",
      { email: EMAIL, code: "000000" },
      env,
      withBinding(binding)
    );
    expect(res.status).toBe(401);
    const row = env.DB.codeStore.get(id)!;
    expect(row.attempts).toBe(1);
    expect(row.expires_at).toBe(new Date(expiresAt).toISOString());
  });

  it("is single-use: success consumes the code, sets the hardened cookie, and writes the S6 session context", async () => {
    seedActiveUser();
    const { id, binding } = await putCode(EMAIL, "123456");
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    const res = await postJSON(app, "/verify-code", { email: EMAIL, code: "123456" }, env, {
      ...withBinding(binding),
      "user-agent": ua,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    // Single-use: the code row is consumed, so a replay fails.
    expect(env.DB.codeStore.get(id)!.consumed_at).not.toBeNull();
    const replay = await postJSON(
      app,
      "/verify-code",
      { email: EMAIL, code: "123456" },
      env,
      withBinding(binding)
    );
    expect(replay.status).toBe(401);
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toMatch(/^__Host-brimwood-sess=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    // Session landed in D1 with the S6 sign-in context (amr, auth_time,
    // is_staff, ua_summary, city, device_id).
    expect(env.DB.sessionStore.size).toBe(1);
    const sess = [...env.DB.sessionStore.values()][0];
    expect(sess.amr).toBe(JSON.stringify(["email_code"]));
    expect(sess.auth_time).toBe(sess.created_at);
    expect(sess.is_staff).toBe(0);
    expect(sess.ua_summary).toBe("iPhone, Safari");
    expect(sess.city).toBeNull();
    expect(sess.device_id).toBeNull();
    expect(sess.expires_at - sess.created_at).toBe(30 * 24 * 3600 * 1000);
  });

  it("rejects a correct code presented without its browser binding", async () => {
    seedActiveUser();
    const { id } = await putCode(EMAIL, "123456");
    // No binding cookie: a code phished from the inbox is useless.
    const res = await postJSON(app, "/verify-code", { email: EMAIL, code: "123456" }, env);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid code.");
    // The failure is indistinguishable from a wrong code: attempts tick up.
    expect(env.DB.codeStore.get(id)!.attempts).toBe(1);
  });

  it("locks out after 5 attempts and consumes the code", async () => {
    seedActiveUser();
    const { id, binding } = await putCode(EMAIL, "123456");
    for (let i = 0; i < 5; i++) {
      const r = await postJSON(
        app,
        "/verify-code",
        { email: EMAIL, code: "000000" },
        env,
        withBinding(binding)
      );
      expect(r.status).toBe(401);
    }
    expect(env.DB.codeStore.get(id)!.attempts).toBe(5);
    // The 6th guess, even correct, hits the lockout and consumes the code.
    const res = await postJSON(
      app,
      "/verify-code",
      { email: EMAIL, code: "123456" },
      env,
      withBinding(binding)
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/too many attempts/i);
    expect(env.DB.codeStore.get(id)!.consumed_at).not.toBeNull();
  });

  it("the attempts increment is atomic: the guard blocks a racer past the cap", async () => {
    seedActiveUser();
    const { id } = await putCode(EMAIL, "123456", { attempts: 5 });
    // A concurrent wrong guess runs the guarded UPDATE directly: the
    // attempts < ? clause matches nothing, so attempts cannot reach 6.
    const r = await env.DB.prepare(
      "UPDATE auth_email_codes SET attempts = attempts + 1 WHERE id = ? AND attempts < ?"
    )
      .bind(id, 5)
      .run();
    expect(r.meta.changes).toBe(0);
    expect(env.DB.codeStore.get(id)!.attempts).toBe(5);
  });
});

describe("POST /request-code", () => {
  it("throttles per email (5/hr) while pretending success", async () => {
    seedActiveUser();
    const sent: { to: string; subject: string }[] = [];
    restoreFetch = mailStub(sent);
    for (let i = 0; i < 6; i++) {
      const res = await postJSON(app, "/request-code", { email: EMAIL }, env);
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    }
    // 5 codes emailed; the 6th throttled silently.
    expect(sent).toHaveLength(5);
  });

  it("stores a strict expiry with the code record in D1 and binds it to the browser", async () => {
    seedActiveUser();
    const sent: { to: string; subject: string }[] = [];
    restoreFetch = mailStub(sent);
    const res = await postJSON(app, "/request-code", { email: EMAIL }, env);
    expect(res.status).toBe(200);
    const rows = env.DB.inserts.get("auth_email_codes")!;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.expires_at).toBe(new Date(Date.now() + 600_000).toISOString());
    expect(row.purpose).toBe("sign_in");
    expect(String(row.code_hmac)).toMatch(/^[0-9a-f]{64}$/);
    // No attempts column on insert: the table default (0) applies.
    expect(row).not.toHaveProperty("attempts");
    // The browser-binding secret travels only in this cookie.
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toMatch(/__Host-brimwood-cbind=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  });

  it("supersedes the older live code when a fresh code is requested", async () => {
    seedActiveUser();
    const sent: { to: string; subject: string }[] = [];
    restoreFetch = mailStub(sent);
    await postJSON(app, "/request-code", { email: EMAIL }, env);
    await postJSON(app, "/request-code", { email: EMAIL }, env);
    const rows = [...env.DB.codeStore.values()];
    expect(rows).toHaveLength(2);
    // Exactly one live code survives: the first was superseded.
    expect(rows[0].superseded_at).not.toBeNull();
    expect(rows[1].superseded_at).toBeNull();
    expect(rows[1].consumed_at).toBeNull();
  });

  it("never reveals whether an email is registered", async () => {
    // No user seeded: unknown email.
    const sent: { to: string; subject: string }[] = [];
    restoreFetch = mailStub(sent);
    const res = await postJSON(app, "/request-code", { email: "ghost@example.com" }, env);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(sent).toHaveLength(0);
  });
});

describe("POST /logout", () => {
  it("invalidates the session server-side", async () => {
    seedActiveUser();
    const { binding } = await putCode(EMAIL, "123456");
    const verify = await postJSON(app, "/verify-code", { email: EMAIL, code: "123456" }, env, {
      ...withBinding(binding),
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    expect(verify.status).toBe(200);
    expect(env.DB.sessionStore.size).toBe(1);
    const setCookie = verify.headers.get("set-cookie") || "";
    const token = setCookie.match(/^__Host-brimwood-sess=([^;]+);/)![1];

    const res = await app.request(
      "/logout",
      {
        method: "POST",
        headers: { cookie: `__Host-brimwood-sess=${token}` },
      },
      env as any
    );
    expect(res.status).toBe(200);
    expect(env.DB.sessionStore.size).toBe(0);
  });
});

describe("POST /redeem-invite", () => {
  const INVITE = {
    id: "inv-1",
    max_uses: 1,
    uses: 0,
    expires_at: null,
    revoked_at: null,
    email: null,
  };

  /** Handler: no existing user, valid invite; no email sending. */
  function seedRedeem(invite: any = INVITE) {
    delete (env as any).RESEND_API_KEY;
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/from\s+users/i.test(sql)) return { row: null };
      if (/from\s+invite_codes/i.test(sql)) return { row: invite };
      return prev?.(sql, params);
    };
  }

  it("redeems in one batch: redemption row first, then the user, no password", async () => {
    seedRedeem();
    const res = await postJSON(
      app,
      "/redeem-invite",
      { email: "new@example.com", name: "New User", code: "brim-aaaa-bbbb" },
      env
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    // The lookup binds the HMAC of the code, never the plain code (S2).
    const lookup = env.DB.calls.find((c) => /from\s+invite_codes/i.test(c.sql));
    expect(String(lookup!.params[0])).toMatch(/^[0-9a-f]{64}$/);
    // The redemption row carries the invite id and the bound email.
    const redemptions = env.DB.inserts.get("invite_redemptions") || [];
    expect(redemptions).toHaveLength(1);
    expect(redemptions[0].invite_code_id).toBe("inv-1");
    expect(redemptions[0].email).toBe("new@example.com");
    // The user was created exactly once, with no password columns (D1).
    const users = env.DB.inserts.get("users") || [];
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe("new@example.com");
    expect(users[0]).not.toHaveProperty("password_hash");
    // The handler never touches invite_codes.uses itself: the 0023 trigger
    // consumes the use inside the same batch transaction.
    expect(env.DB.calls.find((c) => /update\s+invite_codes/i.test(c.sql))).toBeUndefined();
  });

  it("loses the race cleanly: the trigger rejects, the re-read explains, 400", async () => {
    // The first SELECT saw uses < max_uses, but a concurrent redemption won:
    // the redemption insert raises (simulated), and the re-read shows the
    // invite fully used. Note: the mock records inserts before executing,
    // so this test asserts the response contract, not insert counts.
    delete (env as any).RESEND_API_KEY;
    const prev = env.DB.handler;
    let inviteReads = 0;
    env.DB.handler = (sql, params) => {
      if (/from\s+users/i.test(sql)) return { row: null };
      if (/from\s+invite_codes/i.test(sql)) {
        inviteReads += 1;
        return { row: inviteReads === 1 ? INVITE : { ...INVITE, uses: 1 } };
      }
      if (/insert\s+into\s+invite_redemptions/i.test(sql)) {
        throw new Error("D1_ERROR: invite is not valid for this email");
      }
      return prev?.(sql, params);
    };
    const res = await postJSON(
      app,
      "/redeem-invite",
      { email: "new@example.com", name: "New User", code: "BRIM-AAAA-BBBB" },
      env
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already been used/i);
  });

  it("rejects an expired invite before any insert", async () => {
    seedRedeem({ ...INVITE, expires_at: "2020-01-01T00:00:00.000Z" });
    const res = await postJSON(
      app,
      "/redeem-invite",
      { email: "new@example.com", name: "New User", code: "BRIM-AAAA-BBBB" },
      env
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/expired/i);
    expect(env.DB.inserts.get("invite_redemptions") || []).toHaveLength(0);
    expect(env.DB.inserts.get("users") || []).toHaveLength(0);
  });

  it("rejects a revoked invite", async () => {
    seedRedeem({ ...INVITE, revoked_at: "2026-10-01T00:00:00.000Z" });
    const res = await postJSON(
      app,
      "/redeem-invite",
      { email: "new@example.com", name: "New User", code: "BRIM-AAAA-BBBB" },
      env
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/revoked/i);
  });

  it("rejects an invite bound to a different email", async () => {
    seedRedeem({ ...INVITE, email: "someone-else@example.com" });
    const res = await postJSON(
      app,
      "/redeem-invite",
      { email: "new@example.com", name: "New User", code: "BRIM-AAAA-BBBB" },
      env
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/different email/i);
    expect(env.DB.inserts.get("users") || []).toHaveLength(0);
  });

  it("rejects an unknown code as invalid", async () => {
    delete (env as any).RESEND_API_KEY;
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/from\s+users/i.test(sql)) return { row: null };
      if (/from\s+invite_codes/i.test(sql)) return { row: null };
      return prev?.(sql, params);
    };
    const res = await postJSON(
      app,
      "/redeem-invite",
      { email: "new@example.com", name: "New User", code: "BRIM-AAAA-BBBB" },
      env
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid invite code/i);
  });

  it("rejects an already-registered email", async () => {
    delete (env as any).RESEND_API_KEY;
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/from\s+users/i.test(sql)) return { row: { id: "user-9" } };
      if (/from\s+invite_codes/i.test(sql)) return { row: INVITE };
      return prev?.(sql, params);
    };
    const res = await postJSON(
      app,
      "/redeem-invite",
      { email: "taken@example.com", name: "Taken", code: "BRIM-AAAA-BBBB" },
      env
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already registered/i);
  });
});

/* --- from audit/security-ci: request-code Resend outage behaviour --- */
function withUser(env: ReturnType<typeof mockEnv>) {
  const prev = env.DB.handler;
  env.DB.handler = (sql: string, params: unknown[]) => {
    if (/from\s+users/i.test(sql)) return { row: { id: "u-1", name: "Ada" } };
    return prev?.(sql, params);
  };
}
describe("POST /api/auth/request-code", () => {
  it("sends the code and logs it as sent", async () => {
    const env = mockEnv();
    withUser(env);
    const sent: { to: string; subject: string }[] = [];
    const r = mailStub(sent);
    try {
      const res = await postJSON(app, "/request-code", { email: "ada@example.com" }, env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe("ada@example.com");
      const logs = env.DB.inserts.get("email_log")!;
      expect(logs.some((l) => l.kind === "auth-code" && l.status === "sent")).toBe(true);
    } finally {
      r();
    }
  });

  it("Resend outage: clean 503, logged as failed, no leak", async () => {
    const env = mockEnv();
    withUser(env);
    const r = mailFailStub();
    try {
      const res = await postJSON(app, "/request-code", { email: "ada@example.com" }, env);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(JSON.stringify(body)).not.toMatch(/resend|stack|Error:/i);
      const logs = env.DB.inserts.get("email_log")!;
      expect(logs.some((l) => l.kind === "auth-code" && l.status === "failed")).toBe(true);
    } finally {
      r();
    }
  });

  it("unknown email still pretends success (no validity leak)", async () => {
    const env = mockEnv();
    const res = await postJSON(app, "/request-code", { email: "nobody@example.com" }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
