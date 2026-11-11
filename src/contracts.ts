export interface SteeringInboxOptions {
  readonly maxTargets?: number;
  readonly maxPendingPerTarget?: number;
  readonly maxEventsPerGeneration?: number;
  readonly maxFieldBytes?: number;
  readonly defaultTtlMs?: number;
  readonly maxTtlMs?: number;
  /** Current time as a nonnegative integer in milliseconds. */
  readonly now?: () => number;
}

export interface SteeringEvent {
  readonly id: string;
  readonly sourceRef: string;
  readonly sourceRevision: string;
  readonly expiresAt?: number;
}

export type SteeringBatchId = symbol;

export interface SteeringBatch {
  readonly id: SteeringBatchId;
  readonly events: readonly Readonly<Required<SteeringEvent>>[];
}

export type SteeringOpenResult =
  | { readonly status: "opened"; readonly target: SteeringTarget }
  | {
      readonly status:
        "invalid_target" | "generation_conflict" | "target_limit";
    };

export interface SteeringEnqueueResult {
  readonly status:
    | "accepted"
    | "duplicate"
    | "conflict"
    | "expired"
    | "pending_limit"
    | "event_limit"
    | "sealed"
    | "closed"
    | "invalid_event";
}

export type SteeringClaimResult =
  | { readonly status: "claimed"; readonly batch: SteeringBatch }
  | {
      readonly status:
        "empty" | "busy" | "boundary_settled" | "closed" | "invalid_boundary";
    };

export type SteeringOutcome = "committed" | "released" | "unknown";

export interface SteeringTarget {
  enqueue(event: SteeringEvent): SteeringEnqueueResult;
  claim(boundaryId: string): SteeringClaimResult;
  settle(
    batchId: SteeringBatchId,
    outcome: SteeringOutcome,
  ): "settled" | "stale" | "invalid_outcome";
  seal(): "sealed" | "closed";
  /** Close the handle and return the number of buffered, unsettled events discarded. */
  close(): number;
}

export interface SteeringInbox {
  open(targetId: string, generation: string): SteeringOpenResult;
}
