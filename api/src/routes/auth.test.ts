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
  const INVITE = { id: "inv-1", code: "ABC-123", max_uses: 1, uses: 0, expires_at: null };

  /** Handler: no existing user, valid invite; no email sending. */
  function seedRedeem(invite: any = INVITE, updateResult: any = null) {
    delete (env as any).RESEND_API_KEY;
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/from\s+users/i.test(sql)) return { row: null };
      if (/from\s+invite_codes/i.test(sql)) return { row: invite };
      if (/update\s+invite_codes/i.test(sql) && updateResult) return updateResult;
      return prev?.(sql, params);
    };
  }

  it("consumes one use with an atomic conditional UPDATE", async () => {
    seedRedeem();
    const res = await postJSON(
      app,
      "/redeem-invite",
      { email: "new@example.com", name: "New User", code: "abc-123" },
      env
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    const upd = env.DB.calls.find((c) => /update\s+invite_codes/i.test(c.sql));
    expect(upd, "conditional UPDATE issued").toBeDefined();
    expect(upd!.sql).toMatch(/uses\s*<\s*max_uses/);
    // The user was created exactly once.
    const users = env.DB.inserts.get("users") || [];
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe("new@example.com");
  });

  it("loses the race cleanly: no user created when the consume finds no uses left", async () => {
    // The SELECT saw uses < max_uses, but a concurrent redemption won —
    // the atomic UPDATE then changes 0 rows.
    seedRedeem(INVITE, { changes: 0 });
    const res = await postJSON(
      app,
      "/redeem-invite",
      { email: "new@example.com", name: "New User", code: "ABC-123" },
      env
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already been used/i);
    expect(env.DB.inserts.get("users") || []).toHaveLength(0);
  });

  it("rejects an expired invite before consuming", async () => {
    seedRedeem({ ...INVITE, expires_at: "2020-01-01T00:00:00.000Z" });
    const res = await postJSON(
      app,
      "/redeem-invite",
      { email: "new@example.com", name: "New User", code: "ABC-123" },
      env
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/expired/i);
    const upd = env.DB.calls.find((c) => /update\s+invite_codes/i.test(c.sql));
    expect(upd, "no consume attempted").toBeUndefined();
  });

  it("rejects an already-registered email", async () => {
    delete (env as any).RESEND_API_KEY;
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/from\s+users/i.test(sql)) return { row: { id: "user-9" } };
      return prev?.(sql, params);
    };
    const res = await postJSON(
      app,
      "/redeem-invite",
      { email: "taken@example.com", name: "Taken", code: "ABC-123" },
      env
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already registered/i);
  });
});

/* --- from audit/security-ci: request-code Resend outage behaviour --- */
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
