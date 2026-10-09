/* Form builder API (Phase B): admin creates custom forms, public submits.
 *
 * Public:
 *   GET  /:slug          → published form + ordered fields (404 unless published)
 *   POST /:slug/submit   → validate, Turnstile, rate limit, store, email notify
 * Admin (session, role=admin):
 *   GET    /admin                    → list forms with field + submission counts
 *   POST   /admin                    → create form with fields
 *   PATCH  /admin/:id                → update form metadata
 *   DELETE /admin/:id                → delete form (fields + submissions cascade)
 *   GET    /admin/:id/submissions    → list submissions for a form
 *
 * Mounted by the first mate at /api/forms.
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { sendEmail, shell, fieldRow, esc, INBOX } from "../lib/email";
import { cleanStr, isEmail, isRecord, clientIp } from "../lib/validate";
import { checkRateLimitD1 } from "../lib/ratelimit-d1";
import { verifyTurnstile } from "../lib/turnstile";
import { getAdminUser } from "../lib/auth";

type Env = Bindings & { RESEND_API_KEY?: string; TURNSTILE_SECRET_KEY?: string };
const app = new Hono<{ Bindings: Env }>();

const FIELD_TYPES = ["text", "email", "textarea", "select", "checkbox"] as const;
const STATUSES = ["draft", "published", "closed"] as const;



function slugify(v: string): string {
  return v.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

type Field = {
  id: string;
  label: string;
  field_type: string;
  required: number;
  options: string[] | null;
  position: number;
};

function parseFields(rows: any[]): Field[] {
  return rows.map((r) => {
    let options: string[] | null = null;
    if (r.options) {
      // Tolerate corrupt option JSON: a bad row must not 500 the public form.
      try {
        const parsed = JSON.parse(r.options);
        options = Array.isArray(parsed) ? parsed.map((o) => String(o)) : null;
      } catch {
        options = null;
      }
    }
    return {
      id: r.id,
      label: r.label,
      field_type: r.field_type,
      required: r.required,
      options,
      position: r.position,
    };
  });
}

/* ---------------- Admin ---------------- */

function needAdmin(c: any, admin: any) {
  if (!admin) return c.json({ ok: false, error: "Admin only" }, 403);
  return null;
}

async function audit(DB: D1Database, actorId: string, action: string, detail: string) {
  await DB.prepare("INSERT INTO audit_log (id, actor_id, action, detail) VALUES (?, ?, ?, ?)")
    .bind(crypto.randomUUID(), actorId, action, detail)
    .run()
    .catch(() => {});
}

/** GET /admin — list forms with counts. */
app.get("/admin", async (c) => {
  const admin = await getAdminUser(c);
  const no = needAdmin(c, admin);
  if (no) return no;
  const rows = await c.env.DB.prepare(
    `SELECT f.id, f.slug, f.title, f.description, f.status, f.notify_email, f.created_at,
            (SELECT COUNT(*) FROM form_fields WHERE form_id = f.id) AS field_count,
            (SELECT COUNT(*) FROM form_submissions WHERE form_id = f.id) AS submission_count
     FROM forms f ORDER BY f.created_at DESC`
  ).all();
  return c.json({ ok: true, forms: rows.results });
});

type IncomingField = { label?: unknown; field_type?: unknown; required?: unknown; options?: unknown };

function validateFields(raw: unknown): { ok: boolean; error?: string; fields?: { label: string; field_type: string; required: number; options: string[] | null }[] } {
  if (!Array.isArray(raw)) return { ok: false, error: "fields must be an array" };
  if (raw.length > 50) return { ok: false, error: "Too many fields (max 50)" };
  const out: { label: string; field_type: string; required: number; options: string[] | null }[] = [];
  for (const f of raw as IncomingField[]) {
    const label = cleanStr(f.label, 200);
    const field_type = cleanStr(f.field_type, 20);
    if (!label) return { ok: false, error: "Every field needs a label" };
    if (!(FIELD_TYPES as readonly string[]).includes(field_type)) {
      return { ok: false, error: `Invalid field type: ${field_type}` };
    }
    let options: string[] | null = null;
    if (field_type === "select") {
      if (!Array.isArray(f.options) || f.options.length === 0) {
        return { ok: false, error: `Select field "${label}" needs at least one option` };
      }
      options = (f.options as unknown[]).map((o) => cleanStr(o, 200)).filter(Boolean).slice(0, 30);
      if (!options.length) return { ok: false, error: `Select field "${label}" needs at least one option` };
    }
    out.push({ label, field_type, required: f.required ? 1 : 0, options });
  }
  return { ok: true, fields: out };
}

/** POST /admin — create form with fields. */
app.post("/admin", async (c) => {
  const admin = await getAdminUser(c);
  const no = needAdmin(c, admin);
  if (no) return no;
  const { DB } = c.env;

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid request." }, 400);
  }
  if (!isRecord(raw)) {
    return c.json({ ok: false, error: "Invalid request." }, 400);
  }
  const body = raw;
  const title = cleanStr(body.title, 200);
  const slug = slugify(cleanStr(body.slug || body.title, 120));
  const description = cleanStr(body.description, 2000) || null;
  const notify_email = cleanStr(body.notify_email, 200) || null;
  if (!title) return c.json({ ok: false, error: "Title is required" }, 400);
  if (!slug) return c.json({ ok: false, error: "Slug is required" }, 400);
  if (notify_email && !isEmail(notify_email)) {
    return c.json({ ok: false, error: "Notification email is not valid" }, 400);
  }
  const vf = validateFields(body.fields);
  if (!vf.ok) return c.json({ ok: false, error: vf.error }, 400);

  const existing = await DB.prepare("SELECT id FROM forms WHERE slug = ?").bind(slug).first();
  if (existing) return c.json({ ok: false, error: "A form with that slug already exists" }, 400);

  const id = crypto.randomUUID();
  await DB.prepare(
    "INSERT INTO forms (id, slug, title, description, status, notify_email) VALUES (?, ?, ?, ?, 'draft', ?)"
  )
    .bind(id, slug, title, description, notify_email)
    .run();
  for (let i = 0; i < vf.fields!.length; i++) {
    const f = vf.fields![i];
    await DB.prepare(
      "INSERT INTO form_fields (id, form_id, label, field_type, required, options, position) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(crypto.randomUUID(), id, f.label, f.field_type, f.required, f.options ? JSON.stringify(f.options) : null, i)
      .run();
  }
  await audit(DB, admin!.id, "form.create", `${title} (${slug})`);
  return c.json({ ok: true, id, slug });
});

/** PATCH /admin/:id — update form metadata (not fields; delete + recreate fields via POST for structural changes). */
app.patch("/admin/:id", async (c) => {
  const admin = await getAdminUser(c);
  const no = needAdmin(c, admin);
  if (no) return no;
  const { DB } = c.env;
  const id = c.req.param("id");

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid request." }, 400);
  }
  if (!isRecord(raw)) {
    return c.json({ ok: false, error: "Invalid request." }, 400);
  }
  const body = raw;
  const updates: string[] = [];
  const binds: unknown[] = [];
  if (body.title !== undefined) {
    const v = cleanStr(body.title, 200);
    if (!v) return c.json({ ok: false, error: "Title cannot be empty" }, 400);
    updates.push("title = ?");
    binds.push(v);
  }
  if (body.description !== undefined) {
    updates.push("description = ?");
    binds.push(cleanStr(body.description, 2000) || null);
  }
  if (body.status !== undefined) {
    const v = cleanStr(body.status, 20);
    if (!(STATUSES as readonly string[]).includes(v)) return c.json({ ok: false, error: "Invalid status" }, 400);
    updates.push("status = ?");
    binds.push(v);
  }
  if (body.notify_email !== undefined) {
    const v = cleanStr(body.notify_email, 200) || null;
    if (v && !isEmail(v)) return c.json({ ok: false, error: "Notification email is not valid" }, 400);
    updates.push("notify_email = ?");
    binds.push(v);
  }
  if (body.slug !== undefined) {
    const v = slugify(cleanStr(body.slug, 120));
    if (!v) return c.json({ ok: false, error: "Slug cannot be empty" }, 400);
    const clash = await DB.prepare("SELECT id FROM forms WHERE slug = ? AND id != ?").bind(v, id).first();
    if (clash) return c.json({ ok: false, error: "A form with that slug already exists" }, 400);
    updates.push("slug = ?");
    binds.push(v);
  }
  if (!updates.length) return c.json({ ok: false, error: "Nothing to update" }, 400);

  const res = await DB.prepare(`UPDATE forms SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...binds, id)
    .run();
  if (!res.meta.changes) return c.json({ ok: false, error: "Form not found" }, 404);
  await audit(DB, admin!.id, "form.update", id);
  return c.json({ ok: true });
});

/** DELETE /admin/:id — delete form (fields + submissions cascade). */
app.delete("/admin/:id", async (c) => {
  const admin = await getAdminUser(c);
  const no = needAdmin(c, admin);
  if (no) return no;
  const { DB } = c.env;
  const id = c.req.param("id");
  const res = await DB.prepare("DELETE FROM forms WHERE id = ?").bind(id).run();
  if (!res.meta.changes) return c.json({ ok: false, error: "Form not found" }, 404);
  await audit(DB, admin!.id, "form.delete", id);
  return c.json({ ok: true });
});

/** GET /admin/:id/submissions — list submissions for a form. */
app.get("/admin/:id/submissions", async (c) => {
  const admin = await getAdminUser(c);
  const no = needAdmin(c, admin);
  if (no) return no;
  const { DB } = c.env;
  const id = c.req.param("id");

  const form = await DB.prepare("SELECT id, title FROM forms WHERE id = ?").bind(id).first<{ id: string; title: string }>();
  if (!form) return c.json({ ok: false, error: "Form not found" }, 404);
  const fields = await DB.prepare(
    "SELECT id, label, field_type, position FROM form_fields WHERE form_id = ? ORDER BY position ASC"
  )
    .bind(id)
    .all();
  const subs = await DB.prepare(
    "SELECT id, data, submitted_at FROM form_submissions WHERE form_id = ? ORDER BY submitted_at DESC LIMIT 200"
  )
    .bind(id)
    .all();
  return c.json({
    ok: true,
    form,
    fields: fields.results,
    submissions: (subs.results as any[]).map((s) => {
      // Tolerate corrupt rows: one bad payload must not 500 the whole list.
      let data: unknown = null;
      try {
        data = JSON.parse(s.data as string);
      } catch {
        data = null;
      }
      return { id: s.id, submitted_at: s.submitted_at, data };
    }),
  });
});

/* ---------------- Public ---------------- */

/** GET / — public directory of published forms (slug + title only).
 * Used by the site build to pre-render form pages. */
app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT slug, title, description FROM forms WHERE status = 'published' ORDER BY created_at DESC"
  ).all();
  return c.json({ ok: true, forms: rows.results });
});

/** GET /:slug — published form definition. */
app.get("/:slug", async (c) => {
  const slug = slugify(c.req.param("slug"));
  const form = await c.env.DB.prepare(
    "SELECT id, slug, title, description FROM forms WHERE slug = ? AND status = 'published'"
  )
    .bind(slug)
    .first<{ id: string; slug: string; title: string; description: string | null }>();
  if (!form) return c.json({ ok: false, error: "Form not found" }, 404);
  const fields = await c.env.DB.prepare(
    "SELECT id, label, field_type, required, options, position FROM form_fields WHERE form_id = ? ORDER BY position ASC"
  )
    .bind(form.id)
    .all();
  return c.json({ ok: true, form: { ...form, fields: parseFields(fields.results as any[]) } });
});

/** POST /:slug/submit — validate, Turnstile, store, notify. */
app.post("/:slug/submit", async (c) => {
  const { DB } = c.env;
  const slug = slugify(c.req.param("slug"));

  const form = await DB.prepare(
    "SELECT id, slug, title, notify_email FROM forms WHERE slug = ? AND status = 'published'"
  )
    .bind(slug)
    .first<{ id: string; slug: string; title: string; notify_email: string | null }>();
  if (!form) return c.json({ ok: false, error: "Form not found" }, 404);

  if (!(await checkRateLimitD1(DB, "form:" + slug + ":" + clientIp(c.req.raw), 5, 3600))) {
    return c.json({ ok: false, error: "Too many submissions. Please try again later." }, 429);
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid request." }, 400);
  }
  if (!isRecord(raw)) {
    return c.json({ ok: false, error: "Invalid request." }, 400);
  }
  const body = raw;
  if (cleanStr(body.website, 200)) {
    return c.json({ ok: true }); // honeypot: bot — pretend success, store nothing
  }

  // Turnstile bot check (fails closed).
  const turnstile = await verifyTurnstile(
    body["cf-turnstile-response"],
    (c.env as Env).TURNSTILE_SECRET_KEY,
    clientIp(c.req.raw)
  );
  if (!turnstile.ok) return c.json({ ok: false, error: turnstile.error }, 400);

  const fields = await DB.prepare(
    "SELECT id, label, field_type, required, options, position FROM form_fields WHERE form_id = ? ORDER BY position ASC"
  )
    .bind(form.id)
    .all();
  const parsed = parseFields(fields.results as any[]);
  const responses = isRecord(body.responses) ? body.responses : {};

  // Validate each field.
  const cleaned: Record<string, string | boolean> = {};
  for (const f of parsed) {
    const rawVal = responses[f.id];

    if (f.field_type === "checkbox") {
      const value = rawVal === true || rawVal === "true" || rawVal === "on";
      if (f.required && !value) {
        return c.json({ ok: false, error: `"${f.label}" is required.` }, 400);
      }
      cleaned[f.id] = value;
      continue;
    }

    // Non-scalar payloads (objects/arrays) are rejected outright — coercing
    // them would store "[object Object]" junk.
    if (typeof rawVal === "object" && rawVal !== null) {
      return c.json({ ok: false, error: `"${f.label}" has an invalid value.` }, 400);
    }
    const str = cleanStr(rawVal, 5000);
    if (f.required && !str) {
      return c.json({ ok: false, error: `"${f.label}" is required.` }, 400);
    }
    if (str && f.field_type === "email" && !isEmail(str)) {
      return c.json({ ok: false, error: `"${f.label}" must be a valid email address.` }, 400);
    }
    if (str && f.field_type === "select" && f.options && !f.options.includes(str)) {
      return c.json({ ok: false, error: `"${f.label}" has an invalid choice.` }, 400);
    }
    cleaned[f.id] = str;
  }

  // Idempotency: same key → same logical submission. Duplicate delivery
  // returns success without re-inserting or re-notifying.
  const idemKey =
    cleanStr(body.idempotency_key, 100) ||
    (c.req.header("Idempotency-Key") || "").trim().slice(0, 100);
  if (idemKey) {
    const dup = await DB.prepare("SELECT id FROM form_submissions WHERE idempotency_key = ?")
      .bind(idemKey)
      .first<{ id: string }>()
      .catch(() => null); // column missing (migration not applied yet) → skip
    if (dup) return c.json({ ok: true });
  }

  const payload = JSON.stringify(cleaned);
  try {
    await DB.prepare(
      "INSERT INTO form_submissions (id, form_id, data, idempotency_key) VALUES (?, ?, ?, ?)"
    )
      .bind(crypto.randomUUID(), form.id, payload, idemKey || null)
      .run();
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    if (idemKey && /UNIQUE/i.test(msg)) {
      return c.json({ ok: true }); // lost the race with our own retry — already stored
    }
    if (idemKey && /no such column/i.test(msg)) {
      // Migration 0012 not applied yet — degrade gracefully to a keyless insert.
      await DB.prepare("INSERT INTO form_submissions (id, form_id, data) VALUES (?, ?, ?)")
        .bind(crypto.randomUUID(), form.id, payload)
        .run();
    } else {
      throw e;
    }
  }

  // Notify.
  const resendKey = (c.env as Env).RESEND_API_KEY;
  const to = form.notify_email || INBOX;
  if (resendKey) {
    const rows = parsed
      .map((f) => {
        const v = cleaned[f.id];
        const display = typeof v === "boolean" ? (v ? "Yes" : "No") : v || "—";
        return fieldRow(f.label, String(display));
      })
      .join("");
    const html = shell(
      "New form submission",
      `Someone submitted "${form.title}".`,
      `<p style="margin:0 0 16px;">New submission for <strong>${esc(form.title)}</strong>:</p>` +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + rows + "</table>"
    );
    const subject = `New submission — ${form.title}`;
    try {
      const providerId = await sendEmail(resendKey, {
        to,
        subject,
        html,
        text: `New submission for "${form.title}":\n\n` + parsed.map((f) => `${f.label}: ${String(cleaned[f.id] ?? "—")}`).join("\n"),
      });
      await DB.prepare(
        "INSERT INTO email_log (id, kind, to_email, subject, status, provider_id) VALUES (?, 'form-notify', ?, ?, 'sent', ?)"
      )
        .bind(crypto.randomUUID(), to, subject, providerId || null)
        .run();
    } catch (e) {
      // Best-effort notify: the submission is stored regardless; log the failure.
      await DB.prepare(
        "INSERT INTO email_log (id, kind, to_email, subject, status, error) VALUES (?, 'form-notify', ?, ?, 'failed', ?)"
      )
        .bind(crypto.randomUUID(), to, subject, String((e as Error)?.message || e).slice(0, 500))
        .run()
        .catch(() => {});
    }
  }

  return c.json({ ok: true });
});


export default app;
