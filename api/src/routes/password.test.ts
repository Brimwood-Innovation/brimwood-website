/* Password auth tests (Phase D1): hashing, policy, login, set/change,
 * reset flow, rate limits. Mocks D1/KV/fetch — no network. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "./password";
import { hashPassword, verifyPassword, validatePassword } from "../lib/password";
import {
  mockEnv,
  mockD1,
  memberSession,
  mailStub,
  postJSON,
  type MockEnv,
} from "../test/helpers";

/* Faster PBKDF2 for unit tests (routes use the 600k default). */
const TEST_ITERS = 5000;

let env: MockEnv;
let restoreFetch: (() => void) | null = null;

beforeEach(() => {
  env = mockEnv();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
});

afterEach(() => {
  if (restoreFetch) {
    restoreFetch();
    restoreFetch = null;
  }
  vi.useRealTimers();
});

/** Seed a user row for SELECTs; returns {id, email, hash, salt}.
 * Uses the real 600k PBKDF2 default so route verification matches. */
async function seedUser(
  opts: {
    id?: string;
    email?: string;
    status?: string;
    withPassword?: boolean;
    password?: string;
  } = {}
) {
  const id = opts.id || "user-1";
  const email = opts.email || "user@example.com";
  const status = opts.status || "active";
  let hash: string | null = null;
  let salt: string | null = null;
  if (opts.withPassword) {
    const h = await hashPassword(opts.password || "CorrectHorse12");
    hash = h.hash;
    salt = h.salt;
  }
  const prev = env.DB.handler;
  env.DB.handler = (sql, params) => {
    if (/from\s+users/i.test(sql)) {
      return { row: { id, email, role: "member", status, password_hash: hash, password_salt: salt } };
    }
    return prev?.(sql, params);
  };
  return { id, email, hash, salt };
}

/** Give SESSIONS_KV a list() for invalidateUserSessions. */
function withSessionList() {
  (env.SESSIONS_KV as any).list = async ({ prefix }: { prefix: string }) => {
    const keys = [...env.SESSIONS_KV.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((name) => ({ name }));
    return { keys, list_complete: true, cursor: undefined };
  };
}

describe("password hashing", () => {
  it("produces unique salts for the same password", async () => {
    const a = await hashPassword("CorrectHorse12", TEST_ITERS);
    const b = await hashPassword("CorrectHorse12", TEST_ITERS);
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it("verifies the correct password", async () => {
    const { hash, salt } = await hashPassword("CorrectHorse12", TEST_ITERS);
    expect(await verifyPassword("CorrectHorse12", salt, hash, TEST_ITERS)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const { hash, salt } = await hashPassword("CorrectHorse12", TEST_ITERS);
    expect(await verifyPassword("WrongPassword99", salt, hash, TEST_ITERS)).toBe(false);
  });

  it("rejects a tampered salt", async () => {
    const { hash } = await hashPassword("CorrectHorse12", TEST_ITERS);
    const badSalt = "00".repeat(32);
    expect(await verifyPassword("CorrectHorse12", badSalt, hash, TEST_ITERS)).toBe(false);
  });
});

describe("password policy (Canadian spelling)", () => {
  it("rejects short passwords", () => {
    expect(validatePassword("Short1Aa")).toMatch(/at least 12 characters/);
  });
  it("rejects missing digit", () => {
    expect(validatePassword("NoDigitsHereAa")).toMatch(/at least one number/);
  });
  it("rejects single case", () => {
    expect(validatePassword("alllowercase12")).toMatch(/upper-case and lower-case/);
    expect(validatePassword("ALLUPPERCASE12")).toMatch(/upper-case and lower-case/);
  });
  it("accepts a strong password", () => {
    expect(validatePassword("CorrectHorse12")).toBeNull();
  });
});

describe("POST /login", () => {
  it("succeeds with correct credentials and sets a session", async () => {
    await seedUser({ withPassword: true });
    const res = await postJSON(app, "/login", { email: "user@example.com", password: "CorrectHorse12" }, env);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toContain("brimwood_sess=");
    expect(setCookie).toContain("HttpOnly");
  });

  it("rejects a wrong password with the generic error", async () => {
    await seedUser({ withPassword: true });
    const res = await postJSON(app, "/login", { email: "user@example.com", password: "WrongPassword99" }, env);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid email or password.");
  });

  it("does not enumerate: unknown email gets the identical error", async () => {
    await seedUser({ withPassword: true, email: "other@example.com" });
    const res = await postJSON(app, "/login", { email: "nobody@example.com", password: "Whatever12345" }, env);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: "Invalid email or password." });
  });

  it("rejects suspended users with the generic error", async () => {
    await seedUser({ withPassword: true, status: "suspended" });
    const res = await postJSON(app, "/login", { email: "user@example.com", password: "CorrectHorse12" }, env);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid email or password.");
  });

  it("rejects users with no password set (magic-code only)", async () => {
    await seedUser({ withPassword: false });
    const res = await postJSON(app, "/login", { email: "user@example.com", password: "CorrectHorse12" }, env);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid email or password.");
  });

  it("rate-limits by IP", async () => {
    await seedUser({ withPassword: true });
    // Exhaust the 10/15min IP bucket.
    for (let i = 0; i < 10; i++) {
      await postJSON(app, "/login", { email: "user@example.com", password: "WrongPassword99" }, env);
    }
    const res = await postJSON(app, "/login", { email: "user@example.com", password: "CorrectHorse12" }, env);
    expect(res.status).toBe(429);
  });
});

describe("POST /password/set", () => {
  it("sets an initial password for an authenticated user", async () => {
    await seedUser({ withPassword: false });
    const headers = memberSession(env, "user-1");
    const res = await postJSON(app, "/password/set", { password: "NewPassword12" }, env, headers);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    const upd = env.DB.calls.find((c) => /update\s+users/i.test(c.sql));
    expect(upd).toBeTruthy();
    // params: hash, salt, set_at, updated_at, id — hash and salt are hex.
    expect(String(upd!.params[0])).toMatch(/^[0-9a-f]{64}$/);
    expect(String(upd!.params[1])).toMatch(/^[0-9a-f]{64}$/);
    const auditCall = env.DB.calls.find((c) => /insert\s+into\s+audit_log/i.test(c.sql));
    expect(auditCall?.params).toContain("password.set");
  });

  it("rejects when a password is already set", async () => {
    await seedUser({ withPassword: true });
    const headers = memberSession(env, "user-1");
    const res = await postJSON(app, "/password/set", { password: "NewPassword12" }, env, headers);
    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await postJSON(app, "/password/set", { password: "NewPassword12" }, env);
    expect(res.status).toBe(401);
  });

  it("enforces the password policy", async () => {
    await seedUser({ withPassword: false });
    const headers = memberSession(env, "user-1");
    const res = await postJSON(app, "/password/set", { password: "short" }, env, headers);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at least 12 characters/);
  });
});

describe("POST /password/change", () => {
  it("changes the password with the correct current password", async () => {
    // NOTE: routes use the 600k default; seed with it for a faithful verify.
    const h = await hashPassword("CorrectHorse12");
    const prev = env.DB.handler;
    env.DB.handler = (sql) => {
      if (/from\s+users/i.test(sql)) {
        return { row: { id: "user-1", password_hash: h.hash, password_salt: h.salt } };
      }
      return prev?.(sql, []);
    };
    const headers = memberSession(env, "user-1");
    const res = await postJSON(
      app,
      "/password/change",
      { currentPassword: "CorrectHorse12", newPassword: "EvenBetter34" },
      env,
      headers
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    const auditCall = env.DB.calls.find((c) => /insert\s+into\s+audit_log/i.test(c.sql));
    expect(auditCall?.params).toContain("password.change");
  });

  it("rejects a wrong current password", async () => {
    const h = await hashPassword("CorrectHorse12");
    const prev = env.DB.handler;
    env.DB.handler = (sql) => {
      if (/from\s+users/i.test(sql)) {
        return { row: { id: "user-1", password_hash: h.hash, password_salt: h.salt } };
      }
      return prev?.(sql, []);
    };
    const headers = memberSession(env, "user-1");
    const res = await postJSON(
      app,
      "/password/change",
      { currentPassword: "WrongPassword99", newPassword: "EvenBetter34" },
      env,
      headers
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /password/reset/request", () => {
  it("always returns ok, even for unknown emails (no enumeration)", async () => {
    const res = await postJSON(app, "/password/reset/request", { email: "ghost@example.com" }, env);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(env.DB.inserts.get("password_resets") || []).toHaveLength(0);
  });

  it("creates a reset row and emails the user when they exist", async () => {
    await seedUser({});
    const sent: { to: string; subject: string }[] = [];
    restoreFetch = mailStub(sent);
    const res = await postJSON(app, "/password/reset/request", { email: "user@example.com" }, env);
    expect(res.status).toBe(200);
    const rows = env.DB.inserts.get("password_resets") || [];
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("user@example.com");
    expect(sent[0].subject).toMatch(/password/i);
  });
});

describe("POST /password/reset/confirm", () => {
  // Use a fixed raw token so we can compute its hash deterministically.
  const RAW = "ab".repeat(32);

  async function confirmSetup(overrides: { expiresAt?: string; usedAt?: string | null } = {}) {
    const { sha256Hex } = await import("../lib/validate");
    const expectedHash = await sha256Hex("pwreset:" + RAW);
    const expiresAt = overrides.expiresAt || "2026-10-03T12:29:00.000Z";
    const usedAt = overrides.usedAt ?? null;
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      // Only return the reset row when the queried hash matches the seeded one.
      if (/from\s+password_resets/i.test(sql)) {
        return params[0] === expectedHash
          ? { row: { id: "reset-1", user_id: "user-1", expires_at: expiresAt, used_at: usedAt } }
          : { row: null };
      }
      if (/from\s+users/i.test(sql)) return { row: { id: "user-1", status: "active" } };
      return prev?.(sql, params);
    };
    withSessionList();
    env.SESSIONS_KV.store.set("sess:old-1", JSON.stringify({ userId: "user-1", role: "member" }));
    env.SESSIONS_KV.store.set("sess:other", JSON.stringify({ userId: "user-9", role: "member" }));
  }

  it("sets the password, marks the token used, and kills sessions", async () => {
    await confirmSetup();
    const res = await postJSON(
      app,
      "/password/reset/confirm",
      { token: RAW, newPassword: "FreshStart12" },
      env
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    const upd = env.DB.calls.find((c) => /update\s+users\s+set/i.test(c.sql));
    expect(upd).toBeTruthy();
    const markUsed = env.DB.calls.find((c) => /update\s+password_resets/i.test(c.sql));
    expect(markUsed).toBeTruthy();
    // user-1's session gone, other user's session kept.
    expect(env.SESSIONS_KV.store.has("sess:old-1")).toBe(false);
    expect(env.SESSIONS_KV.store.has("sess:other")).toBe(true);
    const auditCall = env.DB.calls.find((c) => /insert\s+into\s+audit_log/i.test(c.sql));
    expect(auditCall?.params).toContain("password.reset");
  });

  it("rejects a reused token", async () => {
    await confirmSetup({ usedAt: "2026-10-03T12:05:00.000Z" });
    const res = await postJSON(
      app,
      "/password/reset/confirm",
      { token: RAW, newPassword: "FreshStart12" },
      env
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/expired/);
  });

  it("rejects an expired token", async () => {
    await confirmSetup({ expiresAt: "2026-10-03T11:00:00.000Z" });
    const res = await postJSON(
      app,
      "/password/reset/confirm",
      { token: RAW, newPassword: "FreshStart12" },
      env
    );
    expect(res.status).toBe(400);
  });

  it("rejects an unknown token with the same generic error", async () => {
    await confirmSetup();
    const res = await postJSON(
      app,
      "/password/reset/confirm",
      { token: "ff".repeat(32), newPassword: "FreshStart12" },
      env
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid or expired reset link.");
  });

  it("enforces the password policy on reset", async () => {
    await confirmSetup();
    const res = await postJSON(
      app,
      "/password/reset/confirm",
      { token: RAW, newPassword: "weak" },
      env
    );
    expect(res.status).toBe(400);
  });
});
