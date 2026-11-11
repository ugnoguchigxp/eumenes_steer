import type {
  SteeringBatch,
  SteeringEvent,
  SteeringInbox,
  SteeringInboxOptions,
  SteeringTarget,
} from "./contracts";

const TEN_MINUTES_MS = 600_000;
const encoder = new TextEncoder();

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function settings(options: SteeringInboxOptions) {
  const maxTtlMs = positiveInteger(
    "maxTtlMs",
    options.maxTtlMs ?? TEN_MINUTES_MS,
  );
  const defaultTtlMs = positiveInteger(
    "defaultTtlMs",
    options.defaultTtlMs ?? Math.min(TEN_MINUTES_MS, maxTtlMs),
  );
  if (defaultTtlMs > maxTtlMs) {
    throw new RangeError("defaultTtlMs must be at most maxTtlMs");
  }
  const maxFieldBytes = positiveInteger(
    "maxFieldBytes",
    options.maxFieldBytes ?? 256,
  );
  const now = options.now ?? Date.now;
  return {
    maxTtlMs,
    defaultTtlMs,
    maxTargets: positiveInteger("maxTargets", options.maxTargets ?? 256),
    maxPending: positiveInteger(
      "maxPendingPerTarget",
      options.maxPendingPerTarget ?? 32,
    ),
    maxEvents: positiveInteger(
      "maxEventsPerGeneration",
      options.maxEventsPerGeneration ?? 512,
    ),
    validField(value: string) {
      return (
        typeof value === "string" &&
        value.length <= maxFieldBytes &&
        value.trim().length > 0 &&
        encoder.encode(value).byteLength <= maxFieldBytes
      );
    },
    now() {
      const time = now();
      if (!Number.isSafeInteger(time) || time < 0) {
        throw new RangeError("now must return a nonnegative safe integer");
      }
      return time;
    },
  };
}

type Settings = ReturnType<typeof settings>;
type StoredEvent = SteeringBatch["events"][number];

function createTarget(config: Settings, onClose: () => void): SteeringTarget {
  // Keep accepted IDs for the lifetime of the handle, including after expiry.
  const seen = new Map<string, SteeringEvent>();
  const settled = new Set<string>();
  let pending = new Map<string, StoredEvent>();
  let active: { boundaryId: string; batch: SteeringBatch } | undefined;
  let retry: { boundaryId: string; eventIds: readonly string[] } | undefined;
  let state: "open" | "sealed" | "closed" = "open";
  let remove: (() => void) | undefined = onClose;

  function prune(time: number) {
    for (const [id, event] of pending) {
      if (event.expiresAt <= time) pending.delete(id);
    }
  }

  const target: SteeringTarget = {
    enqueue(event) {
      if (state !== "open") return { status: state };
      if (!event || typeof event !== "object")
        return { status: "invalid_event" };
      const { id, sourceRef, sourceRevision, expiresAt } = event;
      if (
        !config.validField(id) ||
        !config.validField(sourceRef) ||
        !config.validField(sourceRevision) ||
        (expiresAt !== undefined &&
          (!Number.isSafeInteger(expiresAt) || expiresAt < 0))
      ) {
        return { status: "invalid_event" };
      }
      const original = seen.get(id);
      if (original) {
        const same =
          original.sourceRef === sourceRef &&
          original.sourceRevision === sourceRevision &&
          original.expiresAt === expiresAt;
        return { status: same ? "duplicate" : "conflict" };
      }
      const time = config.now();
      const deadline = Math.min(
        expiresAt ?? time + config.defaultTtlMs,
        time + config.maxTtlMs,
        Number.MAX_SAFE_INTEGER,
      );
      if (deadline <= time) return { status: "expired" };
      prune(time);
      if (
        pending.size + (active?.batch.events.length ?? 0) >=
        config.maxPending
      ) {
        return { status: "pending_limit" };
      }
      if (seen.size >= config.maxEvents) return { status: "event_limit" };
      seen.set(id, { id, sourceRef, sourceRevision, expiresAt });
      pending.set(
        id,
        Object.freeze({ id, sourceRef, sourceRevision, expiresAt: deadline }),
      );
      return { status: "accepted" };
    },

    claim(boundaryId) {
      if (state === "closed") return { status: "closed" };
      if (!config.validField(boundaryId)) return { status: "invalid_boundary" };
      if (active) return { status: "busy" };
      if (settled.has(boundaryId)) return { status: "boundary_settled" };
      prune(config.now());
      let events: StoredEvent[] = [];
      if (retry?.boundaryId === boundaryId) {
        for (const id of retry.eventIds) {
          const event = pending.get(id);
          if (event) {
            events.push(event);
            pending.delete(id);
          }
        }
      } else {
        events = [...pending.values()];
        pending.clear();
      }
      if (events.length === 0) return { status: "empty" };
      const batch = Object.freeze({
        id: Symbol(),
        events: Object.freeze(events),
      });
      retry = undefined;
      active = { boundaryId, batch };
      return { status: "claimed", batch };
    },

    settle(batchId, outcome) {
      if (!active || active.batch.id !== batchId) return "stale";
      if (
        outcome !== "committed" &&
        outcome !== "released" &&
        outcome !== "unknown"
      ) {
        return "invalid_outcome";
      }
      const { boundaryId, batch } = active;
      if (outcome === "released") {
        const restored = batch.events.map(
          (event) => [event.id, event] as const,
        );
        // The released events preceded everything that arrived while they were claimed.
        pending = new Map([...restored, ...pending]);
        retry = { boundaryId, eventIds: batch.events.map((event) => event.id) };
      } else {
        settled.add(boundaryId);
      }
      active = undefined;
      return "settled";
    },

    seal() {
      if (state === "closed") return "closed";
      state = "sealed";
      return state;
    },

    close() {
      if (state === "closed") return 0;
      const discarded = pending.size + (active?.batch.events.length ?? 0);
      state = "closed";
      remove?.();
      remove = undefined;
      pending.clear();
      seen.clear();
      settled.clear();
      active = undefined;
      retry = undefined;
      return discarded;
    },
  };
  return Object.freeze(target);
}

export function createSteeringInbox(
  options: SteeringInboxOptions = {},
): SteeringInbox {
  const config = settings(options);
  const targets = new Map<
    string,
    { generation: string; target: SteeringTarget }
  >();
  return {
    open(targetId, generation) {
      if (!config.validField(targetId) || !config.validField(generation)) {
        return { status: "invalid_target" };
      }
      const existing = targets.get(targetId);
      if (existing) {
        return existing.generation === generation
          ? { status: "opened", target: existing.target }
          : { status: "generation_conflict" };
      }
      if (targets.size >= config.maxTargets) return { status: "target_limit" };
      const target = createTarget(config, () => targets.delete(targetId));
      targets.set(targetId, { generation, target });
      return { status: "opened", target };
    },
  };
}
