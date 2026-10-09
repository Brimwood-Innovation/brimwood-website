-- 0015_newsletter_token_expiry.sql — audit/security-ci: newsletter confirm tokens
-- now expire (48h). Previously confirm_token lived forever, so a leaked link
-- confirmed a subscription indefinitely. The verify handler treats expired
-- tokens like unknown ones; legacy rows with NULL expiry read as expired.
-- Additive and nullable: safe to apply on preview/prod via wrangler.

ALTER TABLE newsletter_subscribers ADD COLUMN confirm_token_expires_at TEXT;
