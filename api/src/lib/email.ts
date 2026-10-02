/* Branded email templates + Resend sender (T16).
 * Templates are byte-equivalent in design to the live worker's — the brand
 * shell (emerald header, kit logo, forest footer) is unchanged. */

const FROM = "Brimwood Innovation <introductions@brimwoodinnovation.com>";
const INBOX = "info@brimwoodinnovation.com";
const SITE = "https://brimwoodinnovation.com";
const LOGO_URL = "https://brimwoodinnovation.com/logo-email.png";

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function shell(title: string, preheader: string, bodyHtml: string): string {
  return (
    "<!DOCTYPE html><html><body style=\"margin:0;padding:0;font-family:'Plus Jakarta Sans',-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;background:#F6F8F7;\">" +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' + esc(preheader) + "</div>" +
    '<div style="max-width:560px;margin:0 auto;padding:32px 20px;">' +
    '<div style="background:#0C9463;border-radius:16px 16px 0 0;padding:28px 32px;text-align:center;">' +
    '<img src="' + LOGO_URL + '" alt="Brimwood Innovation" style="height:44px;width:auto;" />' +
    "</div>" +
    '<div style="background:#ffffff;border:1px solid rgba(18,26,22,.08);border-top:0;border-radius:0 0 16px 16px;padding:32px;">' +
    '<h1 style="margin:0 0 16px;font-size:22px;color:#121A16;">' + esc(title) + "</h1>" +
    bodyHtml +
    "</div>" +
    '<p style="text-align:center;font-size:12px;color:#5B6862;margin:24px 0 0;">Brimwood Innovation &middot; Build a business. Build yourself.</p>' +
    "</div></body></html>"
  );
}

export function fieldRow(label: string, value: string): string {
  return (
    '<tr><td style="padding:8px 0;border-bottom:1px solid rgba(18,26,22,.08);font-size:13px;color:#5B6862;width:140px;">' +
    esc(label) +
    '</td><td style="padding:8px 0 8px 16px;border-bottom:1px solid rgba(18,26,22,.08);font-size:14px;color:#121A16;">' +
    esc(value || "—") +
    "</td></tr>"
  );
}

export function button(url: string, label: string): string {
  return (
    '<p style="margin:20px 0;"><a href="' + esc(url) + '" style="display:inline-block;background:#0C9463;color:#ffffff;' +
    'text-decoration:none;font-weight:600;font-size:15px;padding:14px 32px;border-radius:10px;">' + esc(label) + "</a></p>"
  );
}

export function page(title: string, heading: string, message: string): Response {
  const html =
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>" + esc(title) + " — Brimwood Innovation</title></head>" +
    '<body style="margin:0;font-family:\'Plus Jakarta Sans\',-apple-system,\'Segoe UI\',Helvetica,Arial,sans-serif;background:#F6F8F7;color:#121A16;">' +
    '<div style="max-width:520px;margin:80px auto;padding:0 20px;text-align:center;">' +
    '<img src="' + LOGO_URL + '" alt="Brimwood Innovation" style="height:48px;width:auto;margin-bottom:32px;" />' +
    '<h1 style="font-size:28px;margin:0 0 16px;">' + esc(heading) + "</h1>" +
    '<div style="font-size:16px;color:#5B6862;">' + message + "</div>" +
    '<p style="margin-top:40px;"><a href="' + SITE + '" style="color:#0C9463;">Back to brimwoodinnovation.com</a></p>' +
    "</div></body></html>";
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export type EmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
};

export async function sendEmail(
  resendKey: string,
  { to, subject, html, text, replyTo, headers }: EmailInput
): Promise<string> {
  const payload: Record<string, unknown> = {
    from: FROM,
    to: [to],
    subject,
    html,
    text,
  };
  if (replyTo) payload.reply_to = replyTo;
  if (headers) payload.headers = headers;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: "Bearer " + resendKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error("Resend " + r.status + " " + detail.slice(0, 300));
  }
  const data = (await r.json().catch(() => ({}))) as { id?: string };
  return data.id ?? "";
}

export { INBOX, SITE };
