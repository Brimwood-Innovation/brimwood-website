/* Route tests: form builder — submission validation, admin gates, best-effort notify. */
import { describe, it, expect } from "vitest";
import app from "./forms";
import {
  mockEnv,
  adminSession,
  memberSession,
  turnstileStub,
  mailStub,
  mailFailStub,
  postJSON,
  postRaw,
} from "../test/helpers";

const FORM = { id: "f1", slug: "contact", title: "Contact", notify_email: null };
const FIELDS = [
  { id: "fld-name", label: "Name", field_type: "text", required: 1, options: null, position: 0 },
  { id: "fld-email", label: "Email", field_type: "email", required: 1, options: null, position: 1 },
  { id: "fld-topic", label: "Topic", field_type: "select", required: 0, options: JSON.stringify(["a", "b"]), position: 2 },
  { id: "fld-ok", label: "Consent", field_type: "checkbox", required: 1, options: null, position: 3 },
];

function formEnv(status = "published") {
  const env = mockEnv();
  env.DB.handler = (sql) => {
    if (/from\s+forms\s+where\s+slug/i.test(sql)) return { row: status === "published" ? FORM : null };
    if (/from\s+form_fields/i.test(sql)) return { results: FIELDS };
  };
  return env;
}

const submit = (env: ReturnType<typeof mockEnv>, responses: unknown, slug = "contact") =>
  postJSON(
    app,
    `/${slug}/submit`,
    { responses, "cf-turnstile-response": "tok" },
    env
  );

const validResponses = {
  "fld-name": "Ada",
  "fld-email": "ada@example.com",
  "fld-topic": "a",
  "fld-ok": true,
};

describe("public form reads", () => {
  it("GET /:slug 404s unless published", async () => {
    const env = formEnv("draft");
    const res = await app.request("/contact", {}, env as any);
    expect(res.status).toBe(404);
  });

  it("GET /:slug returns fields ordered by position", async () => {
    const env = formEnv();
    const res = await app.request("/contact", {}, env as any);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.form.fields.map((f: any) => f.id)).toEqual([
      "fld-name",
      "fld-email",
      "fld-topic",
      "fld-ok",
    ]);
  });
});

describe("POST /:slug/submit validation", () => {
  it("rejects missing required field", async () => {
    const env = formEnv();
    const r = await turnstileStub(true);
    try {
      const res = await submit(env, { ...validResponses, "fld-name": " " });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toMatch(/Name/);
    } finally {
      r();
    }
  });

  it("rejects invalid email format", async () => {
    const env = formEnv();
    const r = await turnstileStub(true);
    try {
      const res = await submit(env, { ...validResponses, "fld-email": "nope" });
      expect(res.status).toBe(400);
    } finally {
      r();
    }
  });

  it("rejects select choice not in options", async () => {
    const env = formEnv();
    const r = await turnstileStub(true);
    try {
      const res = await submit(env, { ...validResponses, "fld-topic": "evil" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toMatch(/invalid choice/i);
    } finally {
      r();
    }
  });

  it("rejects unchecked required checkbox", async () => {
    const env = formEnv();
    const r = await turnstileStub(true);
    try {
      const res = await submit(env, { ...validResponses, "fld-ok": false });
      expect(res.status).toBe(400);
    } finally {
      r();
    }
  });

  it("fails closed on Turnstile failure and stores nothing", async () => {
    const env = formEnv();
    const r = await turnstileStub(false);
    try {
      const res = await submit(env, validResponses);
      expect(res.status).toBe(400);
      expect(env.DB.inserts.get("form_submissions")).toBeUndefined();
    } finally {
      r();
    }
  });

  it("rejects malformed JSON with 400", async () => {
    const env = formEnv();
    const res = await postRaw(app, "/contact/submit", "{bad", env);
    expect(res.status).toBe(400);
  });

  it("stores the submission as JSON on success", async () => {
    const env = formEnv();
    const r = await turnstileStub(true);
    try {
      const res = await submit(env, validResponses);
      expect(res.status).toBe(200);
      const rows = env.DB.inserts.get("form_submissions")!;
      expect(rows).toHaveLength(1);
      const data = JSON.parse(rows[0].data as string);
      expect(data["fld-name"]).toBe("Ada");
      expect(data["fld-ok"]).toBe(true);
    } finally {
      r();
    }
  });

  it("notifies INBOX when the form has no notify_email", async () => {
    const env = formEnv();
    const sent: { to: string; subject: string }[] = [];
    const r1 = await turnstileStub(true);
    const r2 = mailStub(sent);
    try {
      await submit(env, validResponses);
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe("info@brimwoodinnovation.com");
    } finally {
      r1();
      r2();
    }
  });

  it("Resend outage does not lose the submission (best-effort)", async () => {
    const env = formEnv();
    const r1 = await turnstileStub(true);
    const r2 = mailFailStub();
    try {
      const res = await submit(env, validResponses);
      expect(res.status).toBe(200);
      expect(env.DB.inserts.get("form_submissions")).toHaveLength(1);
    } finally {
      r1();
      r2();
    }
  });
});

describe("admin gates (forms requireAdmin)", () => {
  // BUG (reported, not fixed per Phase C rules): in forms.ts, `app.get("/:slug")`
  // is registered before `app.get("/admin")`, so Hono routes GET /admin to the
  // Regression test for the route-shadowing bug (fixed Phase C): /admin must
  // be registered before /:slug so it reaches the admin list handler.
  it("GET /admin rejects anonymous with 403", async () => {
    const res = await app.request("/admin", {}, mockEnv() as any);
    expect(res.status).toBe(403);
  });
  it("GET /admin does not leak the form list to anonymous users", async () => {
    const res = await app.request("/admin", {}, mockEnv() as any);
    expect(res.status).not.toBe(200);
  });
  it("GET /admin rejects members (403)", async () => {
    const env = mockEnv();
    const h = memberSession(env);
    const res = await app.request("/admin", { headers: h }, env as any);
    expect(res.status).toBe(403);
  });
  it("DELETE /admin/:id rejects anonymous (403)", async () => {
    expect((await app.request("/admin/f1", { method: "DELETE" }, mockEnv() as any)).status).toBe(403);
  });
  it("GET /admin/:id/submissions rejects anonymous (403)", async () => {
    expect((await app.request("/admin/f1/submissions", {}, mockEnv() as any)).status).toBe(403);
  });
});

describe("POST /admin create validation", () => {
  const create = (env: ReturnType<typeof mockEnv>, body: unknown, h: Record<string, string>) =>
    postJSON(app, "/admin", body, env, h);

  it("rejects unknown field types", async () => {
    const env = mockEnv();
    const h = adminSession(env);
    const res = await create(env, { title: "T", fields: [{ label: "X", field_type: "upload" }] }, h);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/invalid field type/i);
  });

  it("rejects select fields without options", async () => {
    const env = mockEnv();
    const h = adminSession(env);
    const res = await create(
      env, { title: "T", fields: [{ label: "Pick", field_type: "select", options: [] }] }, h
    );
    expect(res.status).toBe(400);
  });

  it("rejects duplicate slugs", async () => {
    const env = mockEnv();
    const h = adminSession(env);
    const prev = env.DB.handler;
    env.DB.handler = (sql) => {
      if (/from\s+forms\s+where\s+slug/i.test(sql)) return { row: { id: "other" } };
      return prev?.(sql, []);
    };
    const res = await create(env, { title: "T", fields: [] }, h);
    expect(res.status).toBe(400);
  });

  it("creates forms as drafts with ordered fields", async () => {
    const env = mockEnv();
    const h = adminSession(env);
    const res = await create(
      env,
      { title: "Intake", fields: [{ label: "Name", field_type: "text", required: true }] },
      h
    );
    expect(res.status).toBe(200);
    const forms = env.DB.inserts.get("forms")!;
    expect(forms[0].status).toBe("draft");
    const fields = env.DB.inserts.get("form_fields")!;
    expect(fields).toHaveLength(1);
    expect(fields[0].position).toBe(0);
    expect(fields[0].required).toBe(1);
  });
});
