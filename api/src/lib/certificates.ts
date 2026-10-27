/* Shared certificate issuance (SPEC D3, Phase 4).
 *
 * One code path serves both issuers, so a manual admin issue and the
 * automatic issue on reflection-gated course completion can never
 * drift apart: the same code format, the same canonical string, the
 * same Ed25519 signature, and the same one-valid-certificate rule.
 *
 * Callers: POST /api/certificates/issue (manual, admin only, reason
 * required) and POST /api/progress/:lessonId (automatic, on the lesson
 * that completes a course). The automatic caller never fails the
 * lesson completion when issuance cannot happen: a missing signing
 * configuration or a failed sign is reported back as pending, and
 * the next re-completion of any lesson in the course retries it.
 * The manual caller maps the same outcomes to its HTTP errors.
 *
 * Signing: the private key is a Worker secret, never in D1. The
 * operator sets CERT_SIGNING_KEY (base64url PKCS8 DER of the Ed25519
 * private key) and CERT_SIGNING_KEY_ID (its row in signing_keys,
 * which holds the public key). Without both, issuance is not
 * configured, never a half-signed row.
 *
 * Codes: BRIM-YYYY-XXXXXX, six chars from the 31-symbol alphabet
 * (no 0, O, 1, I, L), drawn with crypto.getRandomValues and rejection
 * sampling so no symbol is favoured. The year is the issue year in
 * UTC, matching the year in issued_at, as the 0031 CHECK requires.
 * A code collision retries with a fresh code; a valid certificate
 * already existing for the enrolment is already_exists, because
 * 0031 allows only one valid certificate per enrolment and
 * certificates are never deleted.
 */

export const CERT_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm + "=".repeat((4 - (norm.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

/** Six code chars by rejection sampling: values 248-255 are discarded so
 *  no alphabet symbol is favoured by the modulo. */
export function randomCodeSuffix(): string {
  let out = "";
  while (out.length < 6) {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (out.length >= 6) break;
      if (b >= 248) continue;
      out += CERT_ALPHABET[b % 31];
    }
  }
  return out;
}

export interface CertEnv {
  DB: any;
  CERT_SIGNING_KEY?: string;
  CERT_SIGNING_KEY_ID?: string;
}

export interface IssueRequest {
  enrollmentId: string;
  hours: number;
  issueSource: "auto" | "manual";
  issuedBy?: string | null;
  issueReason?: string | null;
}

export interface IssuedCertificate {
  id: string;
  code: string;
  member_id: string;
  course_id: string;
  course_title: string;
  enrollment_id: string;
  issued_at: string;
  hours: number;
  visibility: "private";
  status: "valid";
  status_changed_at: null;
  verify_url: string;
}

export type IssueResult =
  | { ok: true; certificate: IssuedCertificate }
  | {
      ok: false;
      reason: "not_configured" | "not_found" | "not_completed" | "already_exists" | "failed";
      code?: string;
    };

/** Issue one certificate, or explain why none was issued. Never throws
 *  for an expected outcome; unexpected D1 errors propagate so the
 *  caller can decide whether completion may still stand. */
export async function issueCertificate(
  env: CertEnv,
  req: IssueRequest,
): Promise<IssueResult> {
  const keyId = env.CERT_SIGNING_KEY_ID;
  const keyMaterial = env.CERT_SIGNING_KEY;
  if (!keyId || !keyMaterial) return { ok: false, reason: "not_configured" };
  const keyRow: any = await env.DB.prepare(
    "SELECT key_id, public_key FROM signing_keys WHERE key_id = ? AND retired_at IS NULL",
  )
    .bind(keyId)
    .first();
  if (!keyRow) return { ok: false, reason: "not_configured" };

  const enrolment: any = await env.DB.prepare(
    `SELECT e.id, e.user_id, e.course_id, e.completed_at, co.title AS course_title
     FROM enrollments e JOIN courses co ON co.id = e.course_id WHERE e.id = ?`,
  )
    .bind(req.enrollmentId)
    .first();
  if (!enrolment) return { ok: false, reason: "not_found" };
  if (!enrolment.completed_at) return { ok: false, reason: "not_completed" };
  const existing: any = await env.DB.prepare(
    "SELECT id, code FROM certificates WHERE enrollment_id = ? AND status = 'valid'",
  )
    .bind(req.enrollmentId)
    .first();
  if (existing) {
    return { ok: false, reason: "already_exists", code: existing.code };
  }

  let signingKey: CryptoKey;
  try {
    signingKey = await crypto.subtle.importKey(
      "pkcs8",
      b64urlDecode(keyMaterial) as BufferSource,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
  } catch {
    return { ok: false, reason: "not_configured" };
  }

  const issuedAt = new Date().toISOString();
  const year = issuedAt.slice(0, 4);
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = `BRIM-${year}-${randomCodeSuffix()}`;
    const canonical = `v1|${code}|${enrolment.user_id}|${enrolment.course_id}|${issuedAt}`;
    let signature: string;
    try {
      const sig = await crypto.subtle.sign(
        "Ed25519",
        signingKey,
        new TextEncoder().encode(canonical) as BufferSource,
      );
      signature = b64urlEncode(new Uint8Array(sig));
    } catch {
      return { ok: false, reason: "failed" };
    }
    try {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO certificates
         (id, code, member_id, course_id, enrollment_id, issued_at, hours,
          canonical, signature, signing_key_id, issue_source, issued_by, issue_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(id, code, enrolment.user_id, enrolment.course_id, req.enrollmentId, issuedAt, req.hours,
          canonical, signature, keyId, req.issueSource, req.issuedBy ?? null, req.issueReason ?? null)
        .run();
      return {
        ok: true,
        certificate: {
          id,
          code,
          member_id: enrolment.user_id,
          course_id: enrolment.course_id,
          course_title: enrolment.course_title,
          enrollment_id: req.enrollmentId,
          issued_at: issuedAt,
          hours: req.hours,
          visibility: "private",
          status: "valid",
          status_changed_at: null,
          verify_url: `/c/${code}`,
        },
      };
    } catch (e: any) {
      const msg = String(e?.message || e || "");
      if (/UNIQUE constraint failed: certificates\.code/.test(msg)) continue;
      if (/certificate needs a completed enrolment/.test(msg)) {
        return { ok: false, reason: "not_completed" };
      }
      throw e;
    }
  }
  return { ok: false, reason: "failed" };
}
