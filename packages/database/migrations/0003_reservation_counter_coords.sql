-- ===========================================================================
-- 0003_reservation_counter_coords.sql — persist the EXACT counter-row coordinates
--   that reserve() bumped onto each budget_reservation (SPEC §16.3). MONEY-CORRECTNESS FIX.
--
-- reserve() bumps ONE budget_window_state row identified by (budget_account_id,
-- window_start, shard), where `shard = hash(request_id) % N` and `window_start` is the
-- caller-provided fixed-window bucket. commit()/rollback()/sweepExpired() must later
-- DECREMENT that SAME row. Previously they recomputed window_start = bucketStart(policy,
-- created_at) and assumed shard = 0 — so for any sharded budget (N>1) or any non-default
-- shard, the release decremented the WRONG (often non-existent) row, permanently stranding
-- the held `reserved_microusd` on the real row (headroom loss + false BUDGET_RESERVE_DENIED).
--
-- Recording the coordinates on the reservation row makes the release path address the exact
-- row reserve touched, with no re-derivation. `shard` mirrors budget_window_state.shard
-- (smallint, default 0). `window_start` is nullable only because it is added to an existing
-- (partitioned) table; reserve() always writes it going forward.
-- ===========================================================================
ALTER TABLE "budget_reservation"
	ADD COLUMN IF NOT EXISTS "window_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "budget_reservation"
	ADD COLUMN IF NOT EXISTS "shard" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
