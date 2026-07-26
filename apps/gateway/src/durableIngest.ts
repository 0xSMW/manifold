import type { HotPathObservationEvent, IngestSink } from "@manifold/ports";
import type { EnqueueObservationIngestInput, EnqueueResult, ObservationIngestJobPayload } from "./jobLedger.js";

/** The queue capability required by the request-scoped observation sink. */
export interface ObservationIngestEnqueuer {
  enqueueObservationIngest(input: EnqueueObservationIngestInput): Promise<EnqueueResult>;
}

export interface DurableIngestSinkOptions {
  workspaceId: string;
  producerId: string;
  ledger: ObservationIngestEnqueuer;
  /** Optional hint to begin draining after the durable write has completed. */
  schedule?: () => void | Promise<void>;
}

/**
 * Collects one gateway request's trace before handing it to the durable job ledger.
 *
 * This deliberately has no shared trace registry: callers construct one sink for one request,
 * which prevents unrelated concurrent requests from being combined in process memory.
 */
export class DurableIngestSink implements IngestSink {
  private readonly workspaceId: string;
  private readonly producerId: string;
  private readonly ledger: ObservationIngestEnqueuer;
  private readonly schedule?: () => void | Promise<void>;
  private readonly events: HotPathObservationEvent[] = [];
  private traceId?: string;
  private terminal = false;
  private lastSeq?: number;

  constructor(options: DurableIngestSinkOptions) {
    this.workspaceId = requireNonEmpty(options.workspaceId, "workspaceId");
    this.producerId = requireNonEmpty(options.producerId, "producerId");
    this.ledger = options.ledger;
    this.schedule = options.schedule;
  }

  async emit(event: HotPathObservationEvent): Promise<void> {
    if (this.terminal) throw new Error("cannot emit observation event after terminal");
    this.assertEvent(event);
    this.events.push(event);
    this.traceId ??= event.traceId;
    this.lastSeq = event.seq;

    if (event.kind !== "terminal") return;

    this.terminal = true;
    const payload: ObservationIngestJobPayload = {
      version: 1,
      workspaceId: this.workspaceId,
      producerId: this.producerId,
      events: [...this.events],
    };
    // Awaiting makes a successful terminal emit a durable handoff boundary.  The idempotency
    // anchor remains stable if an upstream retry recreates this request-scoped sink.
    await this.ledger.enqueueObservationIngest({
      ...payload,
      idempotencyKey: `workspace:${this.workspaceId}:trace:${event.traceId}`,
    });

    // Draining is an optimization only. A scheduler failure must not turn a committed enqueue
    // into a failed request; a cron/worker will pick up the pending ledger row later.
    if (this.schedule) {
      try {
        await this.schedule();
      } catch {
        // Best effort by contract.
      }
    }
  }

  private assertEvent(event: HotPathObservationEvent): void {
    if (this.traceId !== undefined && event.traceId !== this.traceId) {
      throw new Error("cannot mix observation trace ids in one sink");
    }
    if (this.lastSeq !== undefined && event.seq <= this.lastSeq) {
      throw new Error("observation event sequence must be strictly increasing");
    }
    if (
      this.events.length === 0 &&
      event.kind !== "accepted" &&
      event.kind !== "terminal"
    ) {
      throw new Error("observation trace must begin with accepted or terminal");
    }
    if (this.events.length > 0 && event.kind === "accepted") {
      throw new Error("observation trace may contain only one accepted event");
    }
  }
}

function requireNonEmpty(value: string, name: string): string {
  if (value.length === 0) throw new Error(`${name} is required`);
  return value;
}
