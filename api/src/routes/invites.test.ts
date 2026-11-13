/* Member invite route (SCHEMA S2): a member creates a single-use invite
 * bound to one email; the member quota lives in the 0024 trigger and its
 * message is mapped to a friendly 400. */
import { describe, it, expect } from "vitest";
import app from "./invites";
import { mockEnv, memberSession, postJSON, type MockEnv } from "../test/helpers";

function memberEnv(email = "member@example.com") {
  const env: MockEnv = mockEnv();
  const h = memberSession(env, "member-1");
  const prev = env.DB.handler;
  env.DB.handler = (sql, params) => {
    if (/from\s+users/i.test(sql)) {
      return { row: { id: "member-1", email, role: "member", status: "active" } };
    }
    return prev?.(sql, params);
  };
  return { env, h };
}

describe("POST /api/invites (member)", () => {
  it("requires sign-in", async () => {
    const env = mockEnv();
    const res = await postJSON(app, "/", { email: "friend@example.com" }, env);
    expect(res.status).toBe(401);
  });

  it("creates a single-use invite bound to the email, storing only the HMAC", async () => {
    const { env, h } = memberEnv();
    const res = await postJSON(app, "/", { email: "Friend@Example.com" }, env, h);
    expect(res.status).toBe(200);
    const d = (await res.json()) as any;
    expect(d.ok).toBe(true);
    expect(d.code).toMatch(/^BRIM-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    const rows = env.DB.inserts.get("invite_codes") || [];
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("friend@example.com");
    expect(rows[0].max_uses).toBe(1);
    expect(rows[0].created_by).toBe("member-1");
    expect(rows[0].code).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].code).not.toBe(d.code);
  });

  it("rejects inviting yourself", async () => {
    const { env, h } = memberEnv("me@example.com");
    const res = await postJSON(app, "/", { email: "me@example.com" }, env, h);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/yourself/i);
  });

  it("rejects a malformed email", async () => {
    const { env, h } = memberEnv();
    const res = await postJSON(app, "/", { email: "nope" }, env, h);
    expect(res.status).toBe(400);
  });

  it("maps the member quota trigger to a friendly 400", async () => {
    const { env, h } = memberEnv();
    const prev = env.DB.handler;
    env.DB.handler = (sql, params) => {
      if (/insert\s+into\s+invite_codes/i.test(sql)) {
        throw new Error("D1_ERROR: members can send at most 3 invites");
      }
      return prev?.(sql, params);
    };
    const res = await postJSON(app, "/", { email: "friend@example.com" }, env, h);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/3 open invites/i);
  });
});
