# Email deliverability runbook

Status as of 2026-10-08 (audit/email). Sending is via Resend (free tier: 3,000 emails/month, 100/day) from `introductions@brimwoodinnovation.com`.

## Domain authentication — verified live
- **SPF** — passing (set up with the Resend domain verification).
- **DKIM** — passing (Resend signs on the sending domain).
- **DMARC** — passing.
- **Google Postmaster Tools** — domain verified; keep the spam complaint rate under 0.1% (hard ceiling 0.3%).

If mail starts landing in spam: check Postmaster Tools first, then confirm the three records above still pass (DNS changes are the usual culprit).

## Header policy
| Mail | Headers |
|---|---|
| Weekly digest (bulk) | `List-Unsubscribe: <per-recipient unsubscribe URL>` on every send (RFC 2369). Body also carries a visible unsubscribe link — both are required. |
| Newsletter welcome | `List-Unsubscribe: <url>` on every send. |
| Everything else (intro notify/confirm, double opt-in confirm, sign-in codes, RSVP, health alerts) | Transactional — no list headers. The double opt-in *confirm* email intentionally has none (the recipient is not subscribed yet). |

**Open:** RFC 8058 one-click (`List-Unsubscribe-Post: List-Unsubscribe=One-Click`) needs a POST unsubscribe endpoint; the current endpoint is GET-only and GET must never unsubscribe (mail scanners/prefetchers visit links). See `tasks/audit-email.md` finding #3 / #5 for the api-core follow-ups. Do not add the `List-Unsubscribe-Post` header until the POST endpoint exists.

## List hygiene (C$0)
- Double opt-in is enforced — never add an address that did not click confirm.
- Digest sends to `status = 'active'` only; unsubscribes take effect immediately.
- Resend free-tier pacing: the digest loop pauses 1s per 50 sends.
- Future: sunset subscribers with no opens/clicks after 90–180 days (needs click/open tracking or engagement data first — not built yet).

## Templates
All mail uses `shell()` in `api/src/lib/email.ts`: emerald `#0C9463` header, kit reversed logo at `https://brimwoodinnovation.com/logo-email.png` (PNG — email clients cannot display SVG), forest footer. Every send includes a plain-text alternative. Never commit API keys or secrets in templates (gate: CONSTRAINTS.md §8).
