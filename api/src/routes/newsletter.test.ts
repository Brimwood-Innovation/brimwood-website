/* Newsletter compliance tests (Phase 1 item 13, S21): tokens stored as
 * SHA-256, the suppression list joined before every send, and CASL consent
 * records written on opt-in and opt-out. Mocks D1/fetch, no network. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app, {
  emailFingerprint,
  unsubSig,
  isSuppressed,
} from "./newsletter";
import { sha256Hex } from "../lib/validate";
import {
  mockEnv,
  mailStub,
  postJSON,
  stubFetch,
  type MockEnv,
} from "../test/helpers";

const json = (data: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    })
  );

let env: MockEnv;
let restoreFetch: (() => void) | null = null;

beforeEach(() => {
  env = mockEnv();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-24T12:00:00Z"));
});

afterEach(() => {
  if (restoreFetch) {
    restoreFetch();
    restoreFetch = null;
  }
  vi.useRealTimers();
});

const EMAIL = "reader@example.com";

/** Capture full email payloads (to/subject/html) instead of mailStub's summary. */
function mailCapture(captured: { to: string; subject: string; html: string }[]) {
  const hostOf = (url: unknown): string => {
    try {
      return new URL(String(url)).hostname;
    } catch {
      return "";
    }
  };
  return stubFetch((url, init) => {
    const host = hostOf(url);
    if (host === "challenges.cloudflare.com") return json({ success: true });
    if (host === "api.resend.com") {
      const body = JSON.parse(String((init as any)?.body || "{}")) as {
        to?: string[];
        subject?: string;
        html?: string;
      };
      captured.push({ to: body.to?.[0] || "", subject: body.subject || "", html: body.html || "" });
      return json({ id: "msg_test" });
    }
    throw new Error("unexpected fetch: " + url);
  });
}

function tokenFromVerifyMail(html: string): string {
  const m = html.match(/verify\?token=([^"&\s<]+)/);
  if (!m) throw new Error("no verify token in confirm email");
  return decodeURIComponent(m[1]);
}

/** Serve a suppression row for exactly one email fingerprint. */
async function seedSuppressionFor(email: string) {
  const fp = await emailFingerprint(email);
  const prev = env.DB.handler;
  env.DB.handler = (sql, params) => {
    if (/FROM email_suppressions/.test(sql)) {
      return params[0] === fp ? { row: { 1: 1 } } : { row: undefined };
    }
    return prev?.(sql, params);
  };
}

describe("POST / (signup)", () => {
  it("stores SHA-256 token hashes, never the plain tokens", async () => {
    const captured: { to: string; subject: string; html: string }[] = [];
    restoreFetch = mailCapture(captured);
    const res = await postJSON(app, "/", { email: EMAIL, "cf-turnstile-response": "test-token" }, env);
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    const plain = tokenFromVerifyMail(captured[0].html);
    const rows = env.DB.inserts.get("newsletter_subscribers") || [];
    expect(rows).toHaveLength(1);
    expect(rows[0].confirm_token).toBe(await sha256Hex(plain));
    expect(rows[0].confirm_token).toHaveLength(64);
    expect(rows[0].confirm_token).not.toBe(plain);
    expect(rows[0].unsub_token).toHaveLength(64);
    expect(rows[0].unsub_token).not.toContain("-"); // a UUID would have dashes
  });

  it("sends nothing and stores nothing for a suppressed address (no oracle)", async () => {
    await seedSuppressionFor(EMAIL);
    const sent: { to: string; subject: string }[] = [];
    restoreFetch = mailStub(sent);
    const res = await postJSON(app, "/", { email: EMAIL, "cf-turnstile-response": "test-token" }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
    expect(env.DB.inserts.get("newsletter_subscribers") || []).toHaveLength(0);
    expect(await isSuppressed(env.DB as any, EMAIL)).toBe(true);
    expect(await isSuppressed(env.DB as any, "other@example.com")).toBe(false);
  });
});

describe("GET /verify", () => {
  it("activates with the hashed token and writes the double opt-in consent record", async () => {
    const plain = "tok-plain-verify";
    // Only the SHA-256 of the presented token matches the stored column.
    const realHash = await sha256Hex(plain);
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/FROM newsletter_subscribers/.test(sql)) {
        if (params[0] !== realHash) return { row: undefined };
        return {
          row: {
            email: EMAIL,
            name: "Reader",
            confirm_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
          },
        };
      }
      return prev?.(sql, params);
    };
    const sent: { to: string; subject: string }[] = [];
    restoreFetch = mailStub(sent);
    const res = await app.request(
      `/verify?token=${encodeURIComponent(plain)}`,
      { method: "GET" },
      env as any
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Welcome aboard");
    // Activation stored the hashed replacement unsub token.
    const upd = env.DB.calls.find((c) => /UPDATE newsletter_subscribers/.test(c.sql) && /status='active'/.test(c.sql));
    expect(upd).toBeDefined();
    expect(String(upd!.params[0])).toHaveLength(64);
    // CASL proof: granted double opt-in.
    const consent = env.DB.inserts.get("consent_records") || [];
    expect(consent).toHaveLength(1);
    expect(consent[0].purpose).toBe("newsletter");
    expect(consent[0].granted).toBe(1);
    expect(consent[0].method).toBe("double_opt_in");
    expect(consent[0].email_hmac).toBe(await emailFingerprint(EMAIL));
    // Welcome mail went out (not suppressed).
    expect(sent.some((s) => s.subject.includes("You're on the list"))).toBe(true);
  });

  it("treats a wrong token exactly like an expired one", async () => {
    env.DB.handler = () => ({ row: undefined });
    const res = await app.request("/verify?token=nope", { method: "GET" }, env as any);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("expired");
    expect(env.DB.inserts.get("consent_records") || []).toHaveLength(0);
  });

  it("skips the welcome mail for a suppressed address but still activates", async () => {
    const plain = "tok-plain-verify-2";
    const realHash = await sha256Hex(plain);
    env.DB.handler = (sql, params) => {
      if (/FROM email_suppressions/.test(sql)) return { row: { 1: 1 } };
      if (/FROM newsletter_subscribers/.test(sql)) {
        if (params[0] !== realHash) return { row: undefined };
        return {
          row: {
            email: EMAIL,
            name: "Reader",
            confirm_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
          },
        };
      }
      return undefined;
    };
    const sent: { to: string; subject: string }[] = [];
    restoreFetch = mailStub(sent);
    const res = await app.request(
      `/verify?token=${encodeURIComponent(plain)}`,
      { method: "GET" },
      env as any
    );
    expect(await res.text()).toContain("Welcome aboard");
    // Owner notice still goes out; no welcome mail to the suppressed address.
    expect(sent.some((s) => s.subject.includes("You're on the list"))).toBe(false);
    expect(sent.some((s) => s.subject.includes("New newsletter subscriber"))).toBe(true);
  });
});

describe("unsubscribe", () => {
  it("GET with the token unsubscribes, suppresses, and records the opt-out", async () => {
    const plain = "tok-plain-unsub";
    const realHash = await sha256Hex(plain);
    env.DB.handler = (sql, params) => {
      if (/FROM newsletter_subscribers/.test(sql)) {
        const ok = params.includes(realHash);
        return ok ? { row: { id: "sub-1", email: EMAIL, status: "active" } } : { row: undefined };
      }
      return undefined;
    };
    const res = await app.request(
      `/unsubscribe?email=${encodeURIComponent(EMAIL)}&token=${encodeURIComponent(plain)}`,
      { method: "GET" },
      env as any
    );
    expect(await res.text()).toContain("Unsubscribed");
    const upd = env.DB.calls.find((c) => /status='unsubscribed'/.test(c.sql));
    expect(upd).toBeDefined();
    const consent = env.DB.inserts.get("consent_records") || [];
    expect(consent).toHaveLength(1);
    expect(consent[0].granted).toBe(0);
    expect(consent[0].method).toBe("settings_toggle");
    const supp = env.DB.inserts.get("email_suppressions") || [];
    expect(supp).toHaveLength(1);
    expect(supp[0].reason).toBe("unsubscribe");
    expect(supp[0].email_hmac).toBe(await emailFingerprint(EMAIL));
  });

  it("POST one-click accepts a signed bulk-mail link", async () => {
    env.DB.handler = (sql) => {
      if (/FROM newsletter_subscribers/.test(sql)) {
        return { row: { id: "sub-1", email: EMAIL, status: "active" } };
      }
      return undefined;
    };
    const sig = await unsubSig(env as any, EMAIL);
    const res = await app.request(
      `/unsubscribe?email=${encodeURIComponent(EMAIL)}&sig=${sig}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      },
      env as any
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(env.DB.calls.some((c) => /status='unsubscribed'/.test(c.sql))).toBe(true);
    expect((env.DB.inserts.get("email_suppressions") || [])).toHaveLength(1);
  });

  it("rejects a forged signature without unsubscribing", async () => {
    env.DB.handler = (sql) => {
      if (/FROM newsletter_subscribers/.test(sql)) {
        return { row: { id: "sub-1", email: EMAIL, status: "active" } };
      }
      return undefined;
    };
    const res = await app.request(
      `/unsubscribe?email=${encodeURIComponent(EMAIL)}&sig=forged`,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" },
      env as any
    );
    expect(await res.json()).toEqual({ ok: true }); // idempotent: no oracle
    expect(env.DB.calls.some((c) => /status='unsubscribed'/.test(c.sql))).toBe(false);
    expect(env.DB.inserts.get("email_suppressions") || []).toHaveLength(0);
  });
});
