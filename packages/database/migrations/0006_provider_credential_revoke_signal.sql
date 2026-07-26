-- ===========================================================================
-- 0006_provider_credential_revoke_signal.sql — one revoke signal + machine/CHECK
--   alignment for provider_credential (F23-F3-credential-lifecycle).
-- forward-fix: rotate affected credentials and amend lifecycle constraints through a successor migration.
--
-- Before: revoke was encoded TWICE (status='revoked' AND revoked_at IS NOT NULL),
-- and the domain machine's `rotating` state had no matching status value in the
-- CHECK ('unvalidated','valid','invalid','revoked') — drift.
--
-- After: `revoked_at` is the SINGLE revoke signal (a row is revoked iff
-- revoked_at IS NOT NULL — matching virtual_key, readCredential, and the
-- provider_credential_ws_idx partial index, all of which already key off
-- revoked_at). `status` now tracks only the pre-revoke validation/rotation
-- lifecycle and its CHECK lists every non-terminal machine state incl. 'rotating'.
--
-- Data migration: any legacy row still carrying status='revoked' is re-expressed
-- with revoked_at set (so it stays revoked / excluded from live reads) and a
-- non-terminal status, keeping the set of LIVE credentials unchanged. This runs
-- while the old CHECK is still in force ('invalid' is a legal target under both
-- the old and new CHECK), then the CHECK is swapped.
-- ===========================================================================
UPDATE "provider_credential"
   SET "revoked_at" = COALESCE("revoked_at", now()),
       "status" = 'invalid'
 WHERE "status" = 'revoked';--> statement-breakpoint
ALTER TABLE "provider_credential" DROP CONSTRAINT IF EXISTS "provider_credential_status_chk";--> statement-breakpoint
ALTER TABLE "provider_credential" ADD CONSTRAINT "provider_credential_status_chk" CHECK ("provider_credential"."status" IN ('unvalidated','valid','invalid','rotating'));
