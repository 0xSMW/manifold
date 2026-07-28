-- forward-fix: retain the encrypted outbox row; repair delivery by retrying the invitation's
-- resend operation, which rotates the capability without restoring plaintext.
-- Durable invitation delivery state. The capability is AES-GCM encrypted at rest; plaintext
-- tokens never leave the request process or appear in this outbox.
CREATE TABLE "workspace_invitation_delivery" (
  "invitation_id" text PRIMARY KEY NOT NULL REFERENCES "workspace_invitation"("id") ON DELETE CASCADE,
  "workspace_id" text NOT NULL REFERENCES "workspace"("id"),
  "state" text NOT NULL DEFAULT 'pending',
  "token_ciphertext" bytea NOT NULL,
  "token_iv" bytea NOT NULL,
  "token_tag" bytea NOT NULL,
  "sent_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_invitation_delivery_state_chk" CHECK ("state" IN ('pending','sent','failed'))
);--> statement-breakpoint
CREATE INDEX "workspace_invitation_delivery_workspace_state_idx" ON "workspace_invitation_delivery" ("workspace_id","state");--> statement-breakpoint
ALTER TABLE "workspace_invitation_delivery" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_invitation_delivery" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "workspace_invitation_delivery_rls" ON "workspace_invitation_delivery"
  USING (workspace_id = current_setting('manifold.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('manifold.workspace_id', true));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "workspace_invitation_delivery" TO manifold_app;
