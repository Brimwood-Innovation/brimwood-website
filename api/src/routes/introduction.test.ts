/* Route tests: introduction + newsletter — honeypot, validation, best-effort email. */
import { describe, it, expect } from "vitest";
import introApp from "./introduction";
import newsApp from "./newsletter";
import {
  mockEnv,
  turnstileStub,
  mailStub,
  mailFailStub,
  postJSON,
  postRaw,
} from "../test/helpers";

const introBody = {
  name: "Ada",
  email: "ada@example.com",
  referral: "web",
  message: "Building something.",
  "cf-turnstile-response": "tok",
};

describe("POST /api/introduction", () => {
  it("honeypot pretends success and stores nothing", async () => {
    const env = mockEnv();
    const res = await postJSON(introApp, "/", { ...introBody, website: "bot" }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(env.DB.inserts.get("introduction_requests")).toBeUndefined();
  });

  it("fails closed on Turnstile failure", async () => {
    const env = mockEnv();
    const r = await turnstileStub(false);
    try {
      const res = await postJSON(introApp, "/", introBody, env);
      expect(res.status).toBe(400);
      expect(env.DB.inserts.get("introduction_requests")).toBeUndefined();
    } finally {
      r();
    }
  });

  it("rejects bad name/email", async () => {
    const env = mockEnv();
    const r = await turnstileStub(true);
    try {
      expect((await postJSON(introApp, "/", { ...introBody, name: "" }, env)).status).toBe(400);
      expect((await postJSON(introApp, "/", { ...introBody, email: "bad" }, env)).status).toBe(400);
    } finally {
      r();
    }
  });

  it("rejects malformed JSON with 400", async () => {
    const env = mockEnv();
    const res = await postRaw(introApp, "/", "{{{", env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBeTruthy();
  });

  it("rejects valid-JSON non-object bodies with 400", async () => {
    const env = mockEnv();
    for (const raw of ["null", "[]", '"str"']) {
      const res = await postRaw(introApp, "/", raw, env);
      expect(res.status, raw).toBe(400);
      expect(env.DB.inserts.get("introduction_requests")).toBeUndefined();
    }
  });

  it("lowercases the stored email", async () => {
    const env = mockEnv();
    const r1 = await turnstileStub(true);
    const r2 = mailStub([]);
    try {
      const res = await postJSON(introApp, "/", { ...introBody, email: "Ada@Example.COM" }, env);
      expect(res.status).toBe(200);
      expect(env.DB.inserts.get("introduction_requests")![0].email).toBe("ada@example.com");
    } finally {
      r1();
      r2();
    }
  });

  it("idempotency key: duplicate delivery stores and sends once", async () => {
    const env = mockEnv();
    // The fake DB applies inserts to `inserts`, not to queries — teach the
    // dup-check SELECT to see previously stored rows.
    env.DB.handler = (sql, params) => {
      if (/from\s+introduction_requests\s+where\s+idempotency_key/i.test(sql)) {
        const rows = env.DB.inserts.get("introduction_requests") || [];
        const hit = rows.find((r) => r.idempotency_key === params[0]);
        return { row: hit ? { id: hit.id } : null };
      }
    };
    const r1 = await turnstileStub(true);
    const sent: { to: string; subject: string }[] = [];
    const r2 = mailStub(sent);
    try {
      const headers = { "Idempotency-Key": "idem-123" };
      expect((await postJSON(introApp, "/", introBody, env, headers)).status).toBe(200);
      const again = await postJSON(introApp, "/", introBody, env, headers);
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ ok: true });
      expect(env.DB.inserts.get("introduction_requests")).toHaveLength(1);
      expect(sent).toHaveLength(2); // one notify + one confirm, not four
    } finally {
      r1();
      r2();
    }
  });

  it("idempotency key survives a lost UNIQUE race", async () => {
    const env = mockEnv();
    const prev = env.DB.handler;
    let calls = 0;
    env.DB.handler = (sql, params) => {
      if (/insert\s+into\s+introduction_requests/i.test(sql) && ++calls === 1) {
        throw new Error("UNIQUE constraint failed: introduction_requests.idempotency_key");
      }
      return prev?.(sql, params);
    };
    const r1 = await turnstileStub(true);
    const r2 = mailStub([]);
    try {
      const res = await postJSON(
        introApp, "/", introBody, env, { "Idempotency-Key": "race-1" }
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      r1();
      r2();
    }
  });

  it("rate-limits at 5/hour per IP", async () => {
    const env = mockEnv();
    const r = await turnstileStub(true);
    const sent: { to: string; subject: string }[] = [];
    const r2 = mailStub(sent);
    try {
      for (let i = 0; i < 5; i++) {
        expect((await postJSON(introApp, "/", introBody, env)).status).toBe(200);
      }
      expect((await postJSON(introApp, "/", introBody, env)).status).toBe(429);
    } finally {
      r();
      r2();
    }
  });

  it("stores the request and sends owner notify + confirmation", async () => {
    const env = mockEnv();
    const sent: { to: string; subject: string }[] = [];
    const r1 = await turnstileStub(true);
    const r2 = mailStub(sent);
    try {
      const res = await postJSON(introApp, "/", introBody, env);
      expect(res.status).toBe(200);
      const rows = env.DB.inserts.get("introduction_requests")!;
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("new");
      expect(rows[0].ip_hash).toMatch(/^[0-9a-f]{64}$/); // sha256, not the raw IP
      expect(sent.map((s) => s.to).sort()).toEqual(
        ["ada@example.com", "info@brimwoodinnovation.com"].sort()
      );
    } finally {
      r1();
      r2();
    }
  });

  it("email outage: request still stored, still returns ok (best-effort)", async () => {
    const env = mockEnv();
    const r1 = await turnstileStub(true);
    const r2 = mailFailStub();
    try {
      const res = await postJSON(introApp, "/", introBody, env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(env.DB.inserts.get("introduction_requests")).toHaveLength(1);
      const logs = env.DB.inserts.get("email_log")!;
      expect(logs.some((l) => l.status === "failed")).toBe(true);
    } finally {
      r1();
      r2();
    }
  });

  it("500s without leaking when RESEND_API_KEY is missing", async () => {
    const env = mockEnv({ RESEND_API_KEY: "" });
    const res = await postJSON(introApp, "/", introBody, env);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toMatch(/stack|Error:/i);
  });
});

describe("POST /api/newsletter", () => {
  const sub = (env: ReturnType<typeof mockEnv>, body: unknown) =>
    postJSON(newsApp, "/", { "cf-turnstile-response": "tok", ...(body as object) }, env);

  it("honeypot pretends success and stores nothing", async () => {
    const env = mockEnv();
    const res = await sub(env, { email: "a@b.co", website: "bot" });
    expect(await res.json()).toEqual({ ok: true });
    expect(env.DB.inserts.get("newsletter_subscribers")).toBeUndefined();
  });

  it("rejects invalid email", async () => {
    const env = mockEnv();
    const r = await turnstileStub(true);
    try {
      expect((await sub(env, { email: "bad" })).status).toBe(400);
    } finally {
      r();
    }
  });

  it("rate-limits at 3/hour per IP", async () => {
    const env = mockEnv();
    const r = await turnstileStub(true);
    const sent: { to: string; subject: string }[] = [];
    const r2 = mailStub(sent);
    try {
      for (let i = 0; i < 3; i++) {
        expect((await sub(env, { email: `u${i}@b.co` })).status).toBe(200);
      }
      expect((await sub(env, { email: "u9@b.co" })).status).toBe(429);
    } finally {
      r();
      r2();
    }
  });

  it("already-active subscribers get silent success with no email", async () => {
    const env = mockEnv();
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/from\s+newsletter_subscribers/i.test(sql)) return { row: { status: "active" } };
      return prev?.(sql, params);
    };
    const sent: { to: string; subject: string }[] = [];
    const r1 = await turnstileStub(true);
    const r2 = mailStub(sent);
    try {
      const res = await sub(env, { email: "a@b.co" });
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(0);
      expect(env.DB.inserts.get("newsletter_subscribers")).toBeUndefined();
    } finally {
      r1();
      r2();
    }
  });

  it("confirm-email outage: 500 with a logged failure (no silent pending)", async () => {
    const env = mockEnv();
    const r1 = await turnstileStub(true);
    const r2 = mailFailStub();
    try {
      const res = await sub(env, { email: "a@b.co" });
      expect(res.status).toBe(500);
      expect(((await res.json()) as any).error).toMatch(/confirmation email/i);
      const logs = env.DB.inserts.get("email_log")!;
      expect(logs.some((l) => l.kind === "newsletter-confirm" && l.status === "failed")).toBe(true);
    } finally {
      r1();
      r2();
    }
  });
});

describe("GET /api/newsletter/verify", () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  function verifyEnv(createdAt: string) {
    const env = mockEnv();
    env.DB.handler = (sql) => {
      if (/from\s+newsletter_subscribers/i.test(sql)) {
        return { row: { email: "a@b.co", name: "Ada", created_at: createdAt } };
      }
    };
    return env;
  }
  const get = (env: ReturnType<typeof mockEnv>, token = "tok-1") =>
    newsApp.request("/verify?token=" + token, {}, env as any);

  it("activates a fresh token and sends welcome + owner mail", async () => {
    const env = verifyEnv(hoursAgo(1));
    const sent: { to: string; subject: string }[] = [];
    const r = mailStub(sent);
    try {
      const res = await get(env);
      expect(res.status).toBe(200);
      expect(await res.text()).toMatch(/You're on the list/);
      expect(sent.map((s) => s.to).sort()).toEqual(["a@b.co", "info@brimwoodinnovation.com"].sort());
      const logs = env.DB.inserts.get("email_log")!;
      expect(logs.filter((l) => l.status === "sent")).toHaveLength(2);
      const update = env.DB.calls.find((c) => /update\s+newsletter_subscribers/i.test(c.sql));
      expect(update).toBeDefined();
      expect(update!.sql).toMatch(/confirm_token\s*=\s*NULL/i); // single-use
    } finally {
      r();
    }
  });

  it("rejects tokens older than 48 hours", async () => {
    const env = verifyEnv(hoursAgo(49));
    const sent: { to: string; subject: string }[] = [];
    const r = mailStub(sent);
    try {
      const res = await get(env);
      expect(res.status).toBe(200);
      expect(await res.text()).toMatch(/no longer valid/);
      expect(sent).toHaveLength(0);
      expect(env.DB.calls.some((c) => /update\s+newsletter_subscribers/i.test(c.sql))).toBe(false);
    } finally {
      r();
    }
  });

  it("email outage after activation still shows the success page (logged)", async () => {
    const env = verifyEnv(hoursAgo(1));
    const r = mailFailStub();
    try {
      const res = await get(env);
      expect(res.status).toBe(200);
      expect(await res.text()).toMatch(/You're on the list/);
      const logs = env.DB.inserts.get("email_log")!;
      expect(logs.some((l) => l.status === "failed")).toBe(true);
    } finally {
      r();
    }
  });

  it("unknown token shows the expired page", async () => {
    const env = mockEnv(); // handler null → no subscriber row
    const res = await get(env, "nope");
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/no longer valid/);
  });
});

describe("GET /api/newsletter/unsubscribe", () => {
  const get = (env: ReturnType<typeof mockEnv>, q: string) =>
    newsApp.request("/unsubscribe" + q, {}, env as any);

  it("unsubscribes with a valid email+token", async () => {
    const env = mockEnv();
    env.DB.handler = (sql) => {
      if (/from\s+newsletter_subscribers/i.test(sql)) return { row: { id: "s1" } };
    };
    const res = await get(env, "?email=a%40b.co&token=t1");
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/removed from the list/);
    const update = env.DB.calls.find((c) => /update\s+newsletter_subscribers/i.test(c.sql));
    expect(update!.sql).toMatch(/'unsubscribed'/);
  });

  it("rejects mismatched links", async () => {
    const env = mockEnv(); // no row
    const res = await get(env, "?email=a%40b.co&token=bad");
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/did not match/);
    expect(env.DB.calls.some((c) => /update\s+newsletter_subscribers/i.test(c.sql))).toBe(false);
  });
});
