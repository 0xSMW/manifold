-- Durable bounded chunk state for resumable storage export invocations.
-- forward-fix: preserve verified chunk proofs and cursors; resume or explicitly repair export state.
-- rollback: do not discard live chunk evidence; stop new workers and forward-fix the exporter.
--
-- A detached seal is immutable. Each invocation may upload only one bounded chunk, and
-- completed chunks are immutable evidence used to skip re-upload on retry. A drop remains
-- impossible until every chunk proof and the final manifest are verified, and
-- the existing checkpoint transaction all succeed.
CREATE TABLE "storage_export_chunk" (
  "workspace_id" text NOT NULL,
  "partition_name" text NOT NULL,
  "chunk_number" integer NOT NULL,
  "cursor_created_at" timestamp with time zone NOT NULL,
  "cursor_row_id" text NOT NULL,
  "row_count" bigint NOT NULL,
  "target_uri" text NOT NULL,
  "byte_count" bigint NOT NULL,
  "sha256" text NOT NULL,
  "uncompressed_sha256" text NOT NULL,
  "verified_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id", "partition_name", "chunk_number"),
  CONSTRAINT "storage_export_chunk_number_chk" CHECK ("chunk_number" >= 1),
  CONSTRAINT "storage_export_chunk_row_count_chk" CHECK ("row_count" > 0),
  CONSTRAINT "storage_export_chunk_byte_count_chk" CHECK ("byte_count" > 0),
  CONSTRAINT "storage_export_chunk_sha256_chk" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "storage_export_chunk_uncompressed_sha256_chk" CHECK ("uncompressed_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "storage_export_chunk_attempt_fk"
    FOREIGN KEY ("workspace_id", "partition_name")
    REFERENCES "storage_export_attempt" ("workspace_id", "partition_name")
    ON DELETE CASCADE
);--> statement-breakpoint

ALTER TABLE "storage_export_chunk" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "storage_export_chunk" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "storage_export_chunk_rls" ON "storage_export_chunk"
  USING ("workspace_id" = current_setting('manifold.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('manifold.workspace_id', true));--> statement-breakpoint
-- Chunk evidence is append-only; writers cannot alter or erase an accepted cursor/proof.
REVOKE ALL ON "storage_export_chunk" FROM manifold_app;--> statement-breakpoint
GRANT SELECT ON "storage_export_chunk" TO manifold_app;--> statement-breakpoint
-- Freeze an attempt before final object verification.  This is a forward-only state extension:
-- old exporting/verified/failed rows keep their original shape and append remains impossible
-- while finalizing.
ALTER TABLE "storage_export_attempt" DROP CONSTRAINT "storage_export_attempt_state_chk";--> statement-breakpoint
ALTER TABLE "storage_export_attempt" DROP CONSTRAINT "storage_export_attempt_shape_chk";--> statement-breakpoint
ALTER TABLE "storage_export_attempt"
  ADD CONSTRAINT "storage_export_attempt_state_chk" CHECK ("state" IN ('exporting','finalizing','verified','failed'));--> statement-breakpoint
ALTER TABLE "storage_export_attempt"
  ADD CONSTRAINT "storage_export_attempt_shape_chk" CHECK (
    ("state" IN ('exporting','finalizing') AND "export_manifest_id" IS NULL AND "last_error" IS NULL)
    OR ("state" = 'verified' AND "export_manifest_id" IS NOT NULL AND "last_error" IS NULL)
    OR ("state" = 'failed' AND "export_manifest_id" IS NULL AND "last_error" IS NOT NULL)
  );--> statement-breakpoint
DROP FUNCTION IF EXISTS public.append_storage_export_chunk(text,integer,timestamptz,text,bigint,text,bigint,text,text);--> statement-breakpoint
CREATE FUNCTION public.append_storage_export_chunk(p_partition text, p_number integer, p_cursor_us bigint, p_cursor_id text, p_rows bigint, p_uri text, p_bytes bigint, p_sha text, p_raw_sha text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $function$
DECLARE v_workspace text; v_next integer;
BEGIN
  v_workspace := current_setting('manifold.workspace_id', true); IF v_workspace IS NULL THEN RAISE EXCEPTION 'workspace context required'; END IF;
  PERFORM 1 FROM public.storage_export_attempt WHERE workspace_id=v_workspace AND partition_name=p_partition AND state='exporting' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'export attempt is not appendable'; END IF;
  SELECT coalesce(max(chunk_number),0)+1 INTO v_next FROM public.storage_export_chunk WHERE workspace_id=v_workspace AND partition_name=p_partition;
  IF p_number <> v_next OR EXISTS (
    SELECT 1 FROM public.storage_export_chunk
    WHERE workspace_id=v_workspace AND partition_name=p_partition
      AND (cursor_created_at, cursor_row_id) >= (timestamptz 'epoch' + p_cursor_us * interval '1 microsecond', p_cursor_id)
  ) THEN RAISE EXCEPTION 'invalid storage export chunk sequence'; END IF;
  INSERT INTO public.storage_export_chunk(workspace_id,partition_name,chunk_number,cursor_created_at,cursor_row_id,row_count,target_uri,byte_count,sha256,uncompressed_sha256) VALUES(v_workspace,p_partition,p_number,timestamptz 'epoch' + p_cursor_us * interval '1 microsecond',p_cursor_id,p_rows,p_uri,p_bytes,p_sha,p_raw_sha);
END;$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.append_storage_export_chunk(text,integer,bigint,text,bigint,text,bigint,text,text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.append_storage_export_chunk(text,integer,bigint,text,bigint,text,bigint,text,text) TO manifold_app;--> statement-breakpoint
CREATE FUNCTION public.mark_storage_export_chunk_verified(p_partition text, p_number integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $function$
DECLARE v_workspace text;
BEGIN
  v_workspace := current_setting('manifold.workspace_id', true); IF v_workspace IS NULL THEN RAISE EXCEPTION 'workspace context required'; END IF;
  PERFORM 1 FROM public.storage_export_attempt WHERE workspace_id=v_workspace AND partition_name=p_partition AND state='finalizing' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'export attempt is not finalizing'; END IF;
  UPDATE public.storage_export_chunk SET verified_at=now() WHERE workspace_id=v_workspace AND partition_name=p_partition AND chunk_number=p_number AND verified_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'chunk is not pending verification'; END IF;
END;$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mark_storage_export_chunk_verified(text,integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mark_storage_export_chunk_verified(text,integer) TO manifold_app;
