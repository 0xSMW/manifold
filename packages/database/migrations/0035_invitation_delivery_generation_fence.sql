-- forward-fix: retain every encrypted outbox row; redeploy prior code if needed, then repair a
-- failed delivery through its resend operation. This additive generation fence prevents an older
-- provider caller from settling a capability that a newer resend has replaced.
ALTER TABLE "workspace_invitation_delivery"
  ADD COLUMN "generation" bigint NOT NULL DEFAULT 1,
  ADD COLUMN "token_digest" bytea;--> statement-breakpoint
UPDATE "workspace_invitation_delivery" AS d
SET "token_digest" = i."keyed_hash"
FROM "workspace_invitation" AS i
WHERE i."id" = d."invitation_id" AND d."token_digest" IS NULL;--> statement-breakpoint
ALTER TABLE "workspace_invitation_delivery"
  ALTER COLUMN "token_digest" SET NOT NULL,
  ADD CONSTRAINT "workspace_invitation_delivery_generation_chk" CHECK ("generation" >= 1);--> statement-breakpoint
