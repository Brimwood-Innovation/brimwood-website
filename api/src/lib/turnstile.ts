/* Cloudflare Turnstile verification (T30).
 * Verifies the cf-turnstile-response token server-side before accepting
 * a form submission. Fails closed: no token or failed verification → reject. */
export async function verifyTurnstile(
  token: unknown,
  secretKey: string | undefined,
  remoteIp?: string
): Promise<{ ok: boolean; error?: string }> {
  if (!secretKey) return { ok: false, error: "Turnstile not configured" };
  const t = typeof token === "string" ? token.trim() : "";
  if (!t) return { ok: false, error: "Please complete the security check." };

  try {
    const form = new URLSearchParams();
    form.set("secret", secretKey);
    form.set("response", t);
    if (remoteIp) form.set("remoteip", remoteIp);

    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
      // Bound the upstream call: a hung siteverify must not stall the worker.
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    if (data.success) return { ok: true };
    return { ok: false, error: "Security check failed. Please try again." };
  } catch {
    return { ok: false, error: "Could not verify the security check. Please try again." };
  }
}
