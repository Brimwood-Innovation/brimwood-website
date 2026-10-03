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
    expect((await postRaw(introApp, "/", "{{{", env)).status).toBe(400);
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
});
