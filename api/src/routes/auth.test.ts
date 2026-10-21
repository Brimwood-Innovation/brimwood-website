/* Magic-code auth tests (audit/auth): strict expiresAt enforcement, single-use,
 * per-email throttling, hardened session cookie on verify.
 * Mocks D1/KV/fetch — no network. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "./auth";
import { sha256Hex } from "../lib/validate";
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

async function kvKey(email: string): Promise<string> {
  return "authcode:" + (await sha256Hex("authcode:" + email.toLowerCase()));
}

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

async function putCode(
  email: string,
  code: string,
  overrides: { attempts?: number; expiresAt?: number } = {}
) {
  const key = await kvKey(email);
  const rec = {
    email,
    codeHash: await sha256Hex("code:" + code),
    attempts: overrides.attempts ?? 0,
    expiresAt: overrides.expiresAt ?? Date.now() + 600_000,
  };
  await env.SESSIONS_KV.put(key, JSON.stringify(rec));
  return key;
}

describe("POST /verify-code", () => {
  it("rejects an expired code even when the KV record still exists", async () => {
    seedActiveUser();
    const key = await putCode(EMAIL, "123456", { expiresAt: Date.now() - 1000 });
    const res = await postJSON(app, "/verify-code", { email: EMAIL, code: "123456" }, env);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/expired/i);
    // Expired records are cleaned up.
    expect(await env.SESSIONS_KV.get(key)).toBeNull();
  });

  it("does not extend the code's life on a failed attempt", async () => {
    seedActiveUser();
    const expiresAt = Date.now() + 600_000;
    const key = await putCode(EMAIL, "123456", { expiresAt });
    const res = await postJSON(app, "/verify-code", { email: EMAIL, code: "000000" }, env);
    expect(res.status).toBe(401);
    const rec = JSON.parse((await env.SESSIONS_KV.get(key))!);
    expect(rec.attempts).toBe(1);
    expect(rec.expiresAt).toBe(expiresAt);
  });

  it("is single-use: success deletes the code and sets the hardened cookie", async () => {
    seedActiveUser();
    const key = await putCode(EMAIL, "123456");
    const res = await postJSON(app, "/verify-code", { email: EMAIL, code: "123456" }, env);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(await env.SESSIONS_KV.get(key)).toBeNull();
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toMatch(/^__Host-brimwood-sess=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    // Session landed in D1.
    expect(env.DB.sessionStore.size).toBe(1);
  });

  it("locks out after 5 attempts and deletes the code", async () => {
    seedActiveUser();
    const key = await putCode(EMAIL, "123456");
    for (let i = 0; i < 5; i++) {
      const r = await postJSON(app, "/verify-code", { email: EMAIL, code: "000000" }, env);
      expect(r.status).toBe(401);
    }
    const res = await postJSON(app, "/verify-code", { email: EMAIL, code: "123456" }, env);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/too many attempts/i);
    expect(await env.SESSIONS_KV.get(key)).toBeNull();
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

  it("stores a strict expiry with the code record", async () => {
    seedActiveUser();
    const sent: { to: string; subject: string }[] = [];
    restoreFetch = mailStub(sent);
    const res = await postJSON(app, "/request-code", { email: EMAIL }, env);
    expect(res.status).toBe(200);
    const raw = await env.SESSIONS_KV.get(await kvKey(EMAIL));
    expect(raw).not.toBeNull();
    const rec = JSON.parse(raw!);
    expect(rec.expiresAt).toBe(Date.now() + 600_000);
    expect(rec.attempts).toBe(0);
    expect(rec.codeHash).toMatch(/^[0-9a-f]{64}$/);
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
    const key = await putCode(EMAIL, "123456");
    const verify = await postJSON(app, "/verify-code", { email: EMAIL, code: "123456" }, env);
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
    expect(key).toBeTruthy();
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
