-- 0039_service_enquiries.sql: service tag on introduction requests
-- (Website Redesign Program stage 5, task T11, spec section 3).
--
-- Why: a service detail page opens the introduction flow with its
-- service pre-selected, and the submission is stored in the same
-- introduction_requests table as hub introductions, tagged with the
-- service slug the visitor came from. The tag describes the enquiry,
-- not the visitor; it is the only new field, and it is optional.
-- Hub introductions (no service chosen) store NULL, exactly as rows
-- stored before this migration read. The API validates the value
-- against the 17 public service slugs before it is stored.
-- Additive only: one nullable column plus a partial index for
-- per-service triage. This file ships in the PR unapplied; applying
-- it to any remote database stays founder and token gated.

ALTER TABLE introduction_requests ADD COLUMN service TEXT;
CREATE INDEX idx_intro_service ON introduction_requests (service) WHERE service IS NOT NULL;
