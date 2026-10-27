/* D1 certificate issuance and verification (Phase 4 slice 1, SPEC D3).
 *
 * The schema already exists: certificates, signing_keys, certificate_events
 * and certificate_lookups from migration 0031. This slice adds the API
 * that writes and reads it, plus the public check. No migration here.
 *
 * Routes, mounted at "/api/certificates":
 *   GET  /verify?code=BRIM-YYYY-XXXXXX  public, rate-limited, lookup-logged.
 *   GET  /mine                          member: only their own certificates.
 *   GET  /                             admin: every certificate, newest first.
 *   POST /issue                        admin: manual issue for a completed
 *                                      enrolment (issue_source 'manual').
 *   POST /:id/revoke                   admin: terminal revoke with a reason.
 *   PATCH /:id/visibility              owner: private, link, or public, only
 *                                      while the certificate is valid.
 *
 * Signing: the private key is a Worker secret, never in D1. The operator
 * sets two secrets (wrangler secret put, never in a file): CERT_SIGNING_KEY
 * holds the base64url PKCS8 DER of the Ed25519 private key, and
 * CERT_SIGNING_KEY_ID names its row in signing_keys, which holds the
 * public key (base64url, 43 chars). Without both, issue answers 500
 * "not configured", the same fail-closed pattern as the Studio token.
 * The canonical string is exactly 'v1|CODE|member_id|course_id|issued_at'
 * (the 0031 CHECK enforces it), and the signature is base64url of the
 * 64-byte Ed25519 signature (86 chars, also CHECK-enforced).
 *
 * Codes: BRIM-YYYY-XXXXXX, six chars from the 31-symbol alphabet
 * (no 0, O, 1, I, L), drawn with crypto.getRandomValues and rejection
 * sampling so no symbol is favoured. The year is the issue year in UTC,
 * matching the year in issued_at, as the 0031 CHECK requires. A code
 * collision retries with a fresh code; a valid certificate already
 * existing for the enrolment is a 409, because 0031 allows only one
 * valid certificate per enrolment and certificates are never deleted.
 *
 * Verification states, matching the deck /c/CODE page: a valid public
 * or link certificate shows the holder's current display name, the
 * course title, and the issue date; a valid private one shows only that
 * it is not public (no name, no course); a revoked, superseded, or
 * withdrawn one shows that it is no longer valid and when that changed;
 * an unknown or malformed code shows that nothing matches. The signature
 * is verified against the stored public key before any valid answer is
 * given; a bad signature or a mismatched canonical string is a 500,
 * never a valid page. Lookups are logged in certificate_lookups with
 * HMACs only: no raw code and no raw IP ever lands in that table.
 * Email, lessons, reflections, and cohort peers never appear here.
 *
 * Automatic issue on reflection-gated course completion lives in
 * api/src/lib/certificates.ts and is called from the progress route;
 * this route only issues manually. The member visibility switch on the
 * academy dashboard (Phase 4 slice 3) calls the PATCH visibility route
 * below. Still open: search indexing of public certificates (the check
 * page is noindex; a public certificate needs a per-code head before
 * indexing).
 */
import { Hono } from "hono";
import { b64urlDecode, issueCertificate } from "../lib/certificates";
import { getAdminUser, readSession } from "../lib/auth";
import { hmacSha256Hex } from "../lib/hmac";
import { checkRateLimitD1 } from "../lib/ratelimit-d1";
import { cleanStr, clientIp } from "../lib/validate";
import type { Bindings } from "../index";

const app = new Hono<{ Bindings: Bindings }>();

const CODE_RE = /^BRIM-[0-9]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;
const VISIBILITIES = ["private", "link", "public"];
const VERIFY_LIMIT = 30;
const VERIFY_WINDOW_SECS = 3600;
const MAX_REASON_LEN = 500;
const MAX_LIST = 200;

interface CertRow {
  id: string;
  code: string;
  member_id: string;
  member_display: string | null;
  course_id: string;
  course_title: string | null;
  enrollment_id: string;
  issued_at: string;
  hours: number;
  canonical: string;
  signature: string;
  signing_key_id: string;
  visibility: string;
  status: string;
  status_changed_at: string | null;
  status_reason: string | null;
  public_key: string | null;
}

function certView(row: CertRow) {
  return {
    id: row.id,
    code: row.code,
    member_id: row.member_id,
    member_display: row.member_display,
    course_id: row.course_id,
    course_title: row.course_title,
    enrollment_id: row.enrollment_id,
    issued_at: row.issued_at,
    hours: row.hours,
    visibility: row.visibility,
    status: row.status,
    status_changed_at: row.status_changed_at,
    verify_url: `/c/${row.code}`,
  };
}

const CERT_SELECT = `SELECT cert.id, cert.code, cert.member_id,
  u.display_name AS member_display,
  cert.course_id, co.title AS course_title, cert.enrollment_id,
  cert.issued_at, cert.hours, cert.canonical, cert.signature,
  cert.signing_key_id, cert.visibility, cert.status,
  cert.status_changed_at, cert.status_reason,
  sk.public_key AS public_key
  FROM certificates cert
  JOIN users u ON u.id = cert.member_id
  JOIN courses co ON co.id = cert.course_id
  LEFT JOIN signing_keys sk ON sk.key_id = cert.signing_key_id`;

/* Best-effort lookup log: a logging failure must never break the check,
 * and a missing SESSION_SECRET only means the HMACs are null, never raw. */
async function logLookup(
  c: any,
  certId: string | null,
  code: string,
  result: string,
): Promise<void> {
  try {
    const secret = c.env.SESSION_SECRET as string | undefined;
    const ip = clientIp(c.req.raw);
    const codeHmac = secret
      ? await hmacSha256Hex(secret, `brimwood/cert-lookup/v1:${code}`)
      : null;
    const ipHmac = secret
      ? await hmacSha256Hex(secret, `brimwood/cert-lookup-ip/v1:${ip}`)
      : null;
    await c.env.DB.prepare(
      `INSERT INTO certificate_lookups (certificate_id, code_tried_hmac, result, ip_hmac)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(certId, codeHmac, result, ipHmac)
      .run();
  } catch {
    /* Logging is evidence, not the answer. */
  }
}

/* --- Public verification --- */

app.get("/verify", async (c) => {
  const code = cleanStr(c.req.query("code"), 16).toUpperCase();
  if (!(await checkRateLimitD1(c.env.DB, `cert-verify:${clientIp(c.req.raw)}`, VERIFY_LIMIT, VERIFY_WINDOW_SECS))) {
    await logLookup(c, null, code, "rate_limited");
    return c.json({ ok: false, error: "Too many requests" }, 429);
  }
  if (!CODE_RE.test(code)) {
    await logLookup(c, null, code, "not_found");
    return c.json({ ok: true, state: "not_found" });
  }
  const row = (await c.env.DB.prepare(`${CERT_SELECT} WHERE cert.code = ?`)
    .bind(code)
    .first()) as CertRow | null;
  if (!row) {
    await logLookup(c, null, code, "not_found");
    return c.json({ ok: true, state: "not_found" });
  }

  /* A non-valid certificate is a plain "no longer valid" answer with the
   * change date, whatever its terminal state. The code is never reused. */
  if (row.status !== "valid") {
    await logLookup(c, row.id, code, "revoked");
    return c.json({
      ok: true,
      state: row.status,
      code: row.code,
      status_changed_at: row.status_changed_at,
    });
  }

  /* Valid answers are earned by signature verification, not by the row
   * alone: recompute the canonical string and verify the signature
   * against the stored public key before showing anything. */
  const expected = `v1|${row.code}|${row.member_id}|${row.course_id}|${row.issued_at}`;
  let verified = false;
  try {
    if (row.canonical === expected && row.public_key) {
      const key = await crypto.subtle.importKey(
        "raw",
        b64urlDecode(row.public_key) as BufferSource,
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      verified = await crypto.subtle.verify(
        "Ed25519",
        key,
        b64urlDecode(row.signature) as BufferSource,
        new TextEncoder().encode(row.canonical) as BufferSource,
      );
    }
  } catch {
    verified = false;
  }
  if (!verified) {
    return c.json({ ok: false, error: "Verification failed" }, 500);
  }

  if (row.visibility === "private") {
    await logLookup(c, row.id, code, "private");
    return c.json({ ok: true, state: "private", code: row.code });
  }
  await logLookup(c, row.id, code, "shown");
  return c.json({
    ok: true,
    state: "valid",
    code: row.code,
    display_name: row.member_display,
    course_title: row.course_title,
    issued_at: row.issued_at,
    visibility: row.visibility,
  });
});

/* --- Member and admin lists --- */

app.get("/mine", async (c) => {
  const session = await readSession(c);
  if (!session) return c.json({ ok: false, error: "Sign in required." }, 401);
  const rows = (
    await c.env.DB.prepare(
      `${CERT_SELECT} WHERE cert.member_id = ? ORDER BY cert.issued_at DESC LIMIT ?`,
    )
      .bind(session.userId, MAX_LIST)
      .all()
  ).results as unknown as CertRow[];
  return c.json({ ok: true, certificates: (rows || []).map(certView) });
});

app.get("/", async (c) => {
  const admin = await getAdminUser(c);
  if (!admin) return c.json({ ok: false, error: "Admin only." }, 403);
  const rows = (
    await c.env.DB.prepare(
      `${CERT_SELECT} ORDER BY cert.issued_at DESC LIMIT ?`,
    )
      .bind(MAX_LIST)
      .all()
  ).results as unknown as CertRow[];
  return c.json({ ok: true, certificates: (rows || []).map(certView) });
});

/* --- Manual issuance (admin only) --- */

app.post("/issue", async (c) => {
  const admin = await getAdminUser(c);
  if (!admin) return c.json({ ok: false, error: "Admin only." }, 403);
  let data: any = {};
  try {
    data = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Send an enrolment, hours, and a reason." }, 400);
  }
  const enrollmentId = cleanStr(data?.enrollment_id, 64);
  const reason = cleanStr(data?.issue_reason, MAX_REASON_LEN);
  const hours = data?.hours;
  if (!enrollmentId || !reason || typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0 || hours > 500) {
    return c.json({ ok: false, error: "Send an enrolment, hours between 0 and 500, and a reason." }, 400);
  }
  const result = await issueCertificate(c.env as any, {
    enrollmentId,
    hours,
    issueSource: "manual",
    issuedBy: admin.id,
    issueReason: reason,
  });
  if (!result.ok) {
    if (result.reason === "not_configured") {
      return c.json({ ok: false, error: "Certificate signing is not configured" }, 500);
    }
    if (result.reason === "not_found") {
      return c.json({ ok: false, error: "Enrolment not found." }, 404);
    }
    if (result.reason === "not_completed") {
      return c.json({ ok: false, error: "Enrolment is not complete." }, 400);
    }
    if (result.reason === "already_exists") {
      return c.json(
        { ok: false, error: "A valid certificate already exists for this enrolment.", code: result.code },
        409,
      );
    }
    return c.json({ ok: false, error: "Could not issue a certificate code" }, 500);
  }
  return c.json({ ok: true, certificate: result.certificate });
});

/* --- Revoke (admin only, terminal) --- */

app.post("/:id/revoke", async (c) => {
  const admin = await getAdminUser(c);
  if (!admin) return c.json({ ok: false, error: "Admin only." }, 403);
  const id = (c.req.param("id") || "").slice(0, 64);
  let data: any = {};
  try {
    data = await c.req.json();
  } catch {
    data = {};
  }
  const reason = cleanStr(data?.reason, MAX_REASON_LEN);
  if (!id || !reason) {
    return c.json({ ok: false, error: "Send a certificate and a reason." }, 400);
  }
  const row: any = await c.env.DB.prepare(
    "SELECT id, status FROM certificates WHERE id = ?",
  )
    .bind(id)
    .first();
  if (!row) return c.json({ ok: false, error: "Certificate not found." }, 404);
  if (row.status !== "valid") {
    return c.json({ ok: false, error: "Only a valid certificate can be revoked." }, 409);
  }
  await c.env.DB.prepare(
    `UPDATE certificates SET status = 'revoked', status_changed_at = ?, status_changed_by = ?, status_reason = ?
     WHERE id = ?`,
  )
    .bind(new Date().toISOString(), admin.id, reason, id)
    .run();
  return c.json({ ok: true, id, status: "revoked" });
});

/* --- Visibility (owner only, valid certificates only) --- */

app.patch("/:id/visibility", async (c) => {
  const session = await readSession(c);
  if (!session) return c.json({ ok: false, error: "Sign in required." }, 401);
  const id = (c.req.param("id") || "").slice(0, 64);
  let data: any = {};
  try {
    data = await c.req.json();
  } catch {
    data = {};
  }
  const visibility = cleanStr(data?.visibility, 16);
  if (!id || !VISIBILITIES.includes(visibility)) {
    return c.json({ ok: false, error: "Send a certificate and a visibility of private, link, or public." }, 400);
  }
  const row: any = await c.env.DB.prepare(
    "SELECT id, member_id, status FROM certificates WHERE id = ?",
  )
    .bind(id)
    .first();
  if (!row) return c.json({ ok: false, error: "Certificate not found." }, 404);
  if (row.member_id !== session.userId) {
    return c.json({ ok: false, error: "Not your certificate." }, 403);
  }
  if (row.status !== "valid") {
    return c.json({ ok: false, error: "Only a valid certificate can change visibility." }, 409);
  }
  await c.env.DB.prepare("UPDATE certificates SET visibility = ? WHERE id = ?")
    .bind(visibility, id)
    .run();
  return c.json({ ok: true, id, visibility });
});

export default app;
