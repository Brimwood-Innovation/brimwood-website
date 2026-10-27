/* Route tests: certificates - Phase 4 slice 1, SPEC D3.
 * Manual admin issue for a completed enrolment only, one valid
 * certificate per enrolment, Ed25519-signed canonical records, public
 * verification that shows nothing for a private certificate, terminal
 * revoke, and owner-only visibility. No real D1, no real Worker
 * secrets: keypairs are generated fresh in each test that needs one.
 */
import { describe, it, expect } from "vitest";
import app from "./certificates";
import { mockEnv, adminSession, memberSession, postJSON, type MockEnv } from "../test/helpers";

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm + "=".repeat((4 - (norm.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

async function makeKeypair() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pubRaw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const privPkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    publicB64: b64url(pubRaw),
    privateB64: b64url(privPkcs8),
  };
}

const CERT_ROW = {
  id: "cert-1",
  code: "BRIM-2026-8F3K7Q",
  member_id: "member-1",
  member_display: "Ada",
  course_id: "course-1",
  course_title: "Foundations",
  enrollment_id: "enr-1",
  issued_at: "2026-10-27T10:00:00.000Z",
  hours: 12,
  canonical: "v1|BRIM-2026-8F3K7Q|member-1|course-1|2026-10-27T10:00:00.000Z",
  signature: "",
  signing_key_id: "key-1",
  visibility: "public",
  status: "valid",
  status_changed_at: null,
  status_reason: null,
  public_key: "",
};

async function signedRow(overrides: Record<string, unknown> = {}) {
  const keys = await makeKeypair();
  const row = { ...CERT_ROW, ...overrides };
  const sig = await crypto.subtle.sign(
    "Ed25519",
    keys.privateKey,
    new TextEncoder().encode(row.canonical),
  );
  return { keys, row: { ...row, signature: b64url(new Uint8Array(sig)), public_key: keys.publicB64 } };
}

function certEnv(overrides: Record<string, unknown> = {}) {
  const env = mockEnv(overrides as any);
  const prev = env.DB.handler;
  env.DB.handler = (sql: string, params: unknown[]) => {
    if (/FROM certificates cert/i.test(sql)) {
      if (/WHERE cert\.code/i.test(sql)) return { row: (certEnv as any).row ?? null };
      if (/WHERE cert\.member_id/i.test(sql)) return { results: (certEnv as any).rows ?? [] };
      return { results: (certEnv as any).rows ?? [] };
    }
    if (/FROM signing_keys/i.test(sql)) return { row: (certEnv as any).keyRow ?? null };
    if (/FROM enrollments e/i.test(sql)) return { row: (certEnv as any).enrolment ?? null };
    if (/FROM certificates WHERE enrollment_id/i.test(sql)) return { row: (certEnv as any).existing ?? null };
    if (/FROM certificates WHERE id/i.test(sql)) return { row: (certEnv as any).byId ?? null };
    return prev?.(sql, params);
  };
  return env;
}

const get = (env: MockEnv, headers: Record<string, string>, path: string) =>
  app.request(path, { method: "GET", headers }, env as any);

describe("certificate verify", () => {
  it("shows a valid public certificate only after the signature checks out", async () => {
    const { row } = await signedRow();
    (certEnv as any).row = row;
    const env = certEnv();
    const res = await get(env, {}, "/verify?code=BRIM-2026-8F3K7Q");
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.state).toBe("valid");
    expect(body.display_name).toBe("Ada");
    expect(body.course_title).toBe("Foundations");
    expect(body.issued_at).toBe("2026-10-27T10:00:00.000Z");
    expect(body.email).toBeUndefined();
  });

  it("refuses a valid row whose signature does not match", async () => {
    const { row } = await signedRow();
    (certEnv as any).row = { ...row, signature: b64url(new Uint8Array(64).fill(7)) };
    const env = certEnv();
    const res = await get(env, {}, "/verify?code=BRIM-2026-8F3K7Q");
    expect(res.status).toBe(500);
  });

  it("shows only the private state for a private certificate", async () => {
    const { row } = await signedRow({ visibility: "private" });
    (certEnv as any).row = row;
    const env = certEnv();
    const res = await get(env, {}, "/verify?code=BRIM-2026-8F3K7Q");
    const body: any = await res.json();
    expect(body.state).toBe("private");
    expect(body.display_name).toBeUndefined();
    expect(body.course_title).toBeUndefined();
  });

  it("shows a revoked certificate as no longer valid with its change date", async () => {
    const { row } = await signedRow({ status: "revoked", status_changed_at: "2026-10-27T11:00:00.000Z" });
    (certEnv as any).row = row;
    const env = certEnv();
    const res = await get(env, {}, "/verify?code=BRIM-2026-8F3K7Q");
    const body: any = await res.json();
    expect(body.state).toBe("revoked");
    expect(body.status_changed_at).toBe("2026-10-27T11:00:00.000Z");
  });

  it("answers not_found for unknown and malformed codes alike", async () => {
    (certEnv as any).row = null;
    const env = certEnv();
    for (const code of ["BRIM-2026-ZZZZZZ", "not-a-code"]) {
      const res = await get(env, {}, `/verify?code=${encodeURIComponent(code)}`);
      const body: any = await res.json();
      expect(body.state).toBe("not_found");
    }
  });

  it("rate-limits the public check", async () => {
    (certEnv as any).row = null;
    const env = certEnv();
    env.DB.rateLimitStore.set("cert-verify:unknown", { count: 30, window_start: Date.now() });
    const res = await get(env, {}, "/verify?code=BRIM-2026-8F3K7Q");
    expect(res.status).toBe(429);
  });
});

describe("certificate issue", () => {
  it("issues a signed manual certificate for a completed enrolment", async () => {
    const keys = await makeKeypair();
    const env = mockEnv({ CERT_SIGNING_KEY: keys.privateB64, CERT_SIGNING_KEY_ID: "key-1" } as any);
    const cookie = adminSession(env);
    const prev = env.DB.handler;
    const calls: { sql: string; params: unknown[] }[] = [];
    env.DB.handler = (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (/FROM signing_keys/i.test(sql)) return { row: { key_id: "key-1", public_key: keys.publicB64 } };
      if (/FROM enrollments e/i.test(sql)) {
        return { row: { id: "enr-1", user_id: "member-1", course_id: "course-1", completed_at: "2026-10-26T10:00:00.000Z", course_title: "Foundations" } };
      }
      if (/FROM certificates WHERE enrollment_id/i.test(sql)) return { row: null };
      return prev?.(sql, params);
    };
    const res = await postJSON(app, "/issue", { enrollment_id: "enr-1", hours: 12, issue_reason: "Completed Foundations with capstone." }, env as any, cookie);
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.certificate.code).toMatch(/^BRIM-\d{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    expect(body.certificate.visibility).toBe("private");
    expect(body.certificate.status).toBe("valid");
    const insert = calls.find((c) => /^INSERT INTO certificates/i.test(c.sql));
    expect(insert).toBeDefined();
    const params = insert!.params as unknown[];
    expect(params).toHaveLength(13);
    // Shared issuance path (api/src/lib/certificates.ts): the source is a
    // bound value, not a SQL literal, so it lands in the params.
    expect(params[10]).toBe("manual");
    const canonical = params[7] as string;
    const signature = params[8] as string;
    expect(canonical).toBe(`v1|${body.certificate.code}|member-1|course-1|${body.certificate.issued_at}`);
    expect(signature).toHaveLength(86);
    const ok = await crypto.subtle.verify(
      "Ed25519",
      keys.publicKey,
      b64urlDecode(signature),
      new TextEncoder().encode(canonical),
    );
    expect(ok).toBe(true);
  });

  it("refuses issue without signing configuration, for an incomplete enrolment, and for a second valid certificate", async () => {
    const env = mockEnv();
    const cookie = adminSession(env);
    const res = await postJSON(app, "/issue", { enrollment_id: "enr-1", hours: 12, issue_reason: "Done." }, env as any, cookie);
    expect(res.status).toBe(500);

    const keys = await makeKeypair();
    const env2 = mockEnv({ CERT_SIGNING_KEY: keys.privateB64, CERT_SIGNING_KEY_ID: "key-1" } as any);
    const cookie2 = adminSession(env2);
    const prev2 = env2.DB.handler;
    env2.DB.handler = (sql: string, params: unknown[]) => {
      if (/FROM signing_keys/i.test(sql)) return { row: { key_id: "key-1", public_key: keys.publicB64 } };
      if (/FROM enrollments e/i.test(sql)) {
        return { row: { id: "enr-1", user_id: "member-1", course_id: "course-1", completed_at: null, course_title: "Foundations" } };
      }
      return prev2?.(sql, params);
    };
    const res2 = await postJSON(app, "/issue", { enrollment_id: "enr-1", hours: 12, issue_reason: "Done." }, env2 as any, cookie2);
    expect(res2.status).toBe(400);

    const env3 = mockEnv({ CERT_SIGNING_KEY: keys.privateB64, CERT_SIGNING_KEY_ID: "key-1" } as any);
    const cookie3 = adminSession(env3);
    const prev3 = env3.DB.handler;
    env3.DB.handler = (sql: string, params: unknown[]) => {
      if (/FROM signing_keys/i.test(sql)) return { row: { key_id: "key-1", public_key: keys.publicB64 } };
      if (/FROM enrollments e/i.test(sql)) {
        return { row: { id: "enr-1", user_id: "member-1", course_id: "course-1", completed_at: "2026-10-26T10:00:00.000Z", course_title: "Foundations" } };
      }
      if (/FROM certificates WHERE enrollment_id/i.test(sql)) return { row: { id: "cert-0", code: "BRIM-2026-AAAAAA" } };
      return prev3?.(sql, params);
    };
    const res3 = await postJSON(app, "/issue", { enrollment_id: "enr-1", hours: 12, issue_reason: "Done." }, env3 as any, cookie3);
    const body3: any = await res3.json();
    expect(res3.status).toBe(409);
    expect(body3.code).toBe("BRIM-2026-AAAAAA");
  });

  it("requires admin for issue and validates hours", async () => {
    const env = mockEnv();
    const cookie = memberSession(env, "member-1");
    const res = await postJSON(app, "/issue", { enrollment_id: "enr-1", hours: 12, issue_reason: "Done." }, env as any, cookie);
    expect(res.status).toBe(403);
    const env2 = mockEnv();
    const cookie2 = adminSession(env2);
    const res2 = await postJSON(app, "/issue", { enrollment_id: "enr-1", hours: 0, issue_reason: "Done." }, env2 as any, cookie2);
    expect(res2.status).toBe(400);
  });
});

describe("certificate lists, revoke, visibility", () => {
  it("lists only the caller's certificates, keyed on the caller", async () => {
    (certEnv as any).rows = [{ ...CERT_ROW }, { ...CERT_ROW, id: "cert-2", code: "BRIM-2026-AAAAAA" }];
    const env = certEnv();
    const cookie = memberSession(env, "member-1");
    const res = await get(env, cookie, "/mine");
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.certificates).toHaveLength(2);
    const listCall = env.DB.calls.find((c) => /FROM certificates cert/i.test(c.sql) && /member_id/i.test(c.sql));
    expect(listCall).toBeDefined();
    expect(listCall!.params[0]).toBe("member-1");
  });

  it("keeps the admin list behind the admin gate", async () => {
    (certEnv as any).rows = [];
    const env = certEnv();
    const cookie = memberSession(env, "member-1");
    const res = await get(env, cookie, "/");
    expect(res.status).toBe(403);
  });

  it("revokes a valid certificate and refuses a second revoke", async () => {
    const env = certEnv();
    const cookie = adminSession(env);
    (certEnv as any).byId = { id: "cert-1", status: "valid" };
    const prev = env.DB.handler;
    env.DB.handler = (sql: string, params: unknown[]) => {
      if (/FROM certificates WHERE id/i.test(sql)) return { row: (certEnv as any).byId };
      return prev?.(sql, params);
    };
    const res = await postJSON(app, "/cert-1/revoke", { reason: "Issued in error." }, env as any, cookie);
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe("revoked");
    (certEnv as any).byId = { id: "cert-1", status: "revoked" };
    const res2 = await postJSON(app, "/cert-1/revoke", { reason: "Again." }, env as any, cookie);
    expect(res2.status).toBe(409);
  });

  it("lets only the owner change visibility, and only while valid", async () => {
    const env = certEnv();
    const owner = memberSession(env, "member-1");
    /* A second member needs a second session token: memberSession always
     * uses tok-member, so a second call would overwrite the first. */
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("tok-stranger"));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    env.DB.sessionStore.set(`sess:${hex}`, {
      user_id: "member-2", role: "member", created_at: Date.now(), expires_at: Date.now() + 30 * 24 * 3600 * 1000,
    });
    const stranger = { Cookie: "__Host-brimwood-sess=tok-stranger" };
    const prev = env.DB.handler;
    env.DB.handler = (sql: string, params: unknown[]) => {
      if (/FROM certificates WHERE id/i.test(sql)) return { row: { id: "cert-1", member_id: "member-1", status: "valid" } };
      return prev?.(sql, params);
    };
    const denied = await app.request("/cert-1/visibility", {
      method: "PATCH",
      headers: { ...stranger, "content-type": "application/json" },
      body: JSON.stringify({ visibility: "public" }),
    }, env as any);
    expect(denied.status).toBe(403);
    const ok = await app.request("/cert-1/visibility", {
      method: "PATCH",
      headers: { ...owner, "content-type": "application/json" },
      body: JSON.stringify({ visibility: "public" }),
    }, env as any);
    const body: any = await ok.json();
    expect(ok.status).toBe(200);
    expect(body.visibility).toBe("public");
  });
});
