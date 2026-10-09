/* Route tests: auth magic-code send — success path and Resend outage. */
import { describe, it, expect } from "vitest";
import authApp from "./auth";
import { mockEnv, mailStub, mailFailStub, postJSON } from "../test/helpers";

function withUser(env: ReturnType<typeof mockEnv>) {
  const prev = env.DB.handler;
  env.DB.handler = (sql, params) => {
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
      const res = await postJSON(authApp, "/request-code", { email: "ada@example.com" }, env);
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
      const res = await postJSON(authApp, "/request-code", { email: "ada@example.com" }, env);
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
    const res = await postJSON(authApp, "/request-code", { email: "nobody@example.com" }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
