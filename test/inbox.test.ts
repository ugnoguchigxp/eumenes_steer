import { describe, expect, test } from "bun:test";
import {
  createSteeringInbox,
  type SteeringInbox,
  type SteeringTarget,
} from "eumenes-steer";

function open(inbox: SteeringInbox, id = "run", generation = "1") {
  const opened = inbox.open(id, generation);
  if (opened.status !== "opened") throw new Error(opened.status);
  return opened.target;
}

function claim(target: SteeringTarget, boundaryId: string) {
  const result = target.claim(boundaryId);
  if (result.status !== "claimed") throw new Error(result.status);
  return result.batch;
}

const event = (id: string) => ({
  id,
  sourceRef: `ref-${id}`,
  sourceRevision: "1",
});
const ids = (batch: ReturnType<typeof claim>) =>
  batch.events.map(({ id }) => id);

describe("steering inbox", () => {
  test("claims a frozen FIFO snapshot, with later arrivals in the next batch", () => {
    const target = open(createSteeringInbox({ now: () => 0 }));
    const first = event("a");
    expect(target.claim("step-1").status).toBe("empty");
    expect(target.enqueue(first).status).toBe("accepted");
    first.sourceRef = "changed after enqueue";
    expect(target.enqueue(event("b")).status).toBe("accepted");
    const batch = claim(target, "step-1");
    expect(batch.events).toEqual([
      { ...event("a"), expiresAt: 600_000 },
      { ...event("b"), expiresAt: 600_000 },
    ]);
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.events)).toBe(true);
    expect(Object.isFrozen(batch.events[0])).toBe(true);
    expect(target.enqueue(event("c")).status).toBe("accepted");
    expect(target.claim("step-1").status).toBe("busy");
    expect(target.claim("step-2").status).toBe("busy");
    expect(target.settle(batch.id, "committed")).toBe("settled");
    expect(target.settle(batch.id, "released")).toBe("stale");
    expect(target.claim("step-1").status).toBe("boundary_settled");
    expect(ids(claim(target, "step-2"))).toEqual(["c"]);
  });

  test("releases to the same boundary with the original surviving events and a new token", () => {
    let time = 0;
    const target = open(createSteeringInbox({ now: () => time }));
    target.enqueue({ ...event("expires"), expiresAt: 5 });
    target.enqueue(event("kept"));
    const first = claim(target, "step-1");
    target.enqueue(event("late"));
    time = 5;
    expect(target.settle(first.id, "released")).toBe("settled");
    const retry = claim(target, "step-1");
    expect(ids(retry)).toEqual(["kept"]);
    expect(retry.id).not.toBe(first.id);
    expect(target.settle(first.id, "committed")).toBe("stale");
    expect(target.claim("step-2").status).toBe("busy");
    target.enqueue(event("later"));
    expect(target.settle(retry.id, "released")).toBe("settled");
    expect(ids(claim(target, "step-2"))).toEqual(["kept", "late", "later"]);
  });

  test("an expired retry remains empty without consuming later arrivals", () => {
    let time = 0;
    const target = open(createSteeringInbox({ now: () => time }));
    target.enqueue({ ...event("expires"), expiresAt: 1 });
    const first = claim(target, "step-1");
    target.enqueue(event("late"));
    target.settle(first.id, "released");
    time = 1;
    expect(target.claim("step-1").status).toBe("empty");
    expect(target.claim("step-1").status).toBe("empty");
    expect(ids(claim(target, "step-2"))).toEqual(["late"]);
  });

  test("unknown delivery closes the boundary and does not retry the same event", () => {
    const target = open(createSteeringInbox());
    target.enqueue(event("a"));
    const batch = claim(target, "step-1");
    target.enqueue(event("b"));
    expect(target.settle(batch.id, "other" as "unknown")).toBe(
      "invalid_outcome",
    );
    expect(target.claim("step-2").status).toBe("busy");
    expect(target.settle(batch.id, "unknown")).toBe("settled");
    expect(target.claim("step-1").status).toBe("boundary_settled");
    expect(target.enqueue(event("a")).status).toBe("duplicate");
    expect(ids(claim(target, "step-2"))).toEqual(["b"]);
  });

  test("identical repeats do not renew TTL and different content conflicts", () => {
    let time = 0;
    const target = open(
      createSteeringInbox({ now: () => time, defaultTtlMs: 10, maxTtlMs: 15 }),
    );
    expect(target.enqueue(event("a")).status).toBe("accepted");
    time = 7;
    expect(target.enqueue(event("a")).status).toBe("duplicate");
    expect(target.enqueue({ ...event("a"), expiresAt: 10 }).status).toBe(
      "duplicate",
    );
    expect(target.enqueue({ ...event("a"), expiresAt: 100 }).status).toBe(
      "duplicate",
    );
    expect(
      target.enqueue({ ...event("a"), expiresAt: Number.NaN }).status,
    ).toBe("duplicate");
    expect(
      target.enqueue({ ...event("a"), sourceRef: "different" }).status,
    ).toBe("conflict");
    expect(target.enqueue({ ...event("a"), sourceRevision: "2" }).status).toBe(
      "conflict",
    );
    expect(target.enqueue({ ...event("b"), expiresAt: 100 }).status).toBe(
      "accepted",
    );
    expect(target.enqueue({ ...event("b"), expiresAt: 8 }).status).toBe(
      "duplicate",
    );
    time = 10;
    const batch = claim(target, "step-1");
    expect(batch.events).toEqual([{ ...event("b"), expiresAt: 22 }]);
    expect(target.enqueue(event("a")).status).toBe("duplicate");
    target.settle(batch.id, "committed");
    expect(target.enqueue({ ...event("b"), expiresAt: 100 }).status).toBe(
      "duplicate",
    );
  });

  test("the explicit deadline is absolute and the default respects a reduced maximum", () => {
    let time = 100;
    const target = open(createSteeringInbox({ now: () => time, maxTtlMs: 10 }));
    expect(target.enqueue({ ...event("a"), expiresAt: 100 }).status).toBe(
      "expired",
    );
    expect(target.enqueue({ ...event("a"), expiresAt: 101 }).status).toBe(
      "accepted",
    );
    expect(target.enqueue(event("b")).status).toBe("accepted");
    time = 101;
    expect(claim(target, "step-1").events).toEqual([
      { ...event("b"), expiresAt: 110 },
    ]);
  });

  test("pending counts claimed events, and the generation limit counts expired IDs", () => {
    let time = 0;
    const target = open(
      createSteeringInbox({
        maxPendingPerTarget: 1,
        maxEventsPerGeneration: 2,
        now: () => time,
      }),
    );
    expect(target.enqueue({ ...event("a"), expiresAt: 1 }).status).toBe(
      "accepted",
    );
    const batch = claim(target, "step-1");
    time = 1;
    expect(target.enqueue(event("b")).status).toBe("pending_limit");
    expect(target.settle(batch.id, "released")).toBe("settled");
    expect(target.enqueue({ ...event("b"), expiresAt: 2 }).status).toBe(
      "accepted",
    );
    time = 2;
    expect(target.enqueue(event("c")).status).toBe("event_limit");
    expect(target.claim("step-2").status).toBe("empty");
  });

  test("the default pending and lifetime limits apply without configuration", () => {
    const target = open(createSteeringInbox({ now: () => 0 }));
    for (let batch = 0; batch < 16; batch++) {
      for (let index = 0; index < 32; index++) {
        expect(target.enqueue(event(`${batch}-${index}`)).status).toBe(
          "accepted",
        );
      }
      expect(target.enqueue(event("extra")).status).toBe("pending_limit");
      expect(target.settle(claim(target, String(batch)).id, "committed")).toBe(
        "settled",
      );
    }
    expect(target.enqueue(event("extra")).status).toBe("event_limit");
  });

  test("target capacity, generation and tokens stay isolated across handles and inboxes", () => {
    const inbox = createSteeringInbox({ maxTargets: 2 });
    const first = open(inbox);
    const other = open(inbox, "other");
    expect(open(inbox)).toBe(first);
    expect(inbox.open("run", "2").status).toBe("generation_conflict");
    expect(inbox.open("full", "1").status).toBe("target_limit");
    first.enqueue(event("a"));
    const batch = claim(first, "same");
    other.enqueue(event("a"));
    const otherBatch = claim(other, "same");
    expect(other.settle(batch.id, "committed")).toBe("stale");
    expect(first.close()).toBe(1);
    const next = open(inbox, "run", "2");
    expect(first.close()).toBe(0);
    expect(first.seal()).toBe("closed");
    expect(first.enqueue(event("a")).status).toBe("closed");
    expect(first.claim("same").status).toBe("closed");
    expect(first.settle(batch.id, "released")).toBe("stale");
    expect(next.claim("same").status).toBe("empty");
    expect(next.enqueue(event("a")).status).toBe("accepted");
    const nextBatch = claim(next, "same");
    expect(next.settle(batch.id, "committed")).toBe("stale");
    expect(next.settle(nextBatch.id, "committed")).toBe("settled");
    expect(other.settle(otherBatch.id, "committed")).toBe("settled");
    expect(next.close()).toBe(0);
    const reopened = open(inbox, "run", "2");
    expect(reopened).not.toBe(next);
    expect(reopened.enqueue(event("a")).status).toBe("accepted");
    expect(open(createSteeringInbox(), "run", "2").claim("same").status).toBe(
      "empty",
    );
  });

  test("the sender only enqueues on an open target with a matching generation", () => {
    const inbox = createSteeringInbox({ maxTargets: 1 });
    const send = inbox.enqueue;
    expect(send("missing", "1", event("a")).status).toBe("not_open");
    expect(send(" ", "1", event("a")).status).toBe("invalid_target");
    expect(send("run", "", event("a")).status).toBe("invalid_target");
    const target = open(inbox, "run", "2");
    expect(send("run", "1", event("a")).status).toBe("generation_conflict");
    expect(send("run", "2", event("a")).status).toBe("accepted");
    expect(target.enqueue(event("a")).status).toBe("duplicate");
    expect(send("run", "2", { ...event("b"), sourceRef: "" }).status).toBe(
      "invalid_event",
    );
    target.seal();
    expect(send("run", "2", event("b")).status).toBe("sealed");
    expect(target.close()).toBe(1);
    expect(send("run", "2", event("a")).status).toBe("not_open");
    expect(open(inbox, "different").close()).toBe(0);
    // Reopening even an older generation is the host's explicit decision.
    const reopened = open(inbox, "run", "1");
    expect(send("run", "2", event("a")).status).toBe("generation_conflict");
    expect(send("run", "1", event("a")).status).toBe("accepted");
    expect(ids(claim(reopened, "answer"))).toEqual(["a"]);
  });

  test("sealing preserves pending events for the final boundary and close counts unsettled events", () => {
    const target = open(createSteeringInbox());
    target.enqueue(event("a"));
    claim(target, "step-1");
    target.enqueue(event("b"));
    expect(target.seal()).toBe("sealed");
    expect(target.seal()).toBe("sealed");
    expect(target.enqueue(event("c")).status).toBe("sealed");
    expect(target.close()).toBe(2);

    const final = open(createSteeringInbox());
    final.enqueue(event("a"));
    final.seal();
    const batch = claim(final, "final");
    expect(final.settle(batch.id, "committed")).toBe("settled");
    expect(final.close()).toBe(0);
  });

  test("close counts all unfinalized events, regardless of expiry cleanup", () => {
    for (const prune of [false, true]) {
      let time = 0;
      let clockReads = 0;
      const target = open(
        createSteeringInbox({
          now: () => {
            clockReads++;
            return time;
          },
        }),
      );
      target.enqueue(event("committed"));
      target.settle(claim(target, "first").id, "committed");
      target.enqueue(event("unknown"));
      target.settle(claim(target, "second").id, "unknown");
      target.enqueue({ ...event("unclaimed"), expiresAt: 2 });
      target.enqueue({ ...event("released"), expiresAt: 2 });
      target.settle(claim(target, "third").id, "released");
      target.enqueue({ ...event("late"), expiresAt: 2 });
      time = 2;
      if (prune) expect(target.claim("last").status).toBe("empty");
      const before = clockReads;
      expect(target.close()).toBe(3);
      expect(clockReads).toBe(before);
      expect(target.close()).toBe(0);
    }
  });

  test("rejects blank, oversized or malformed fields and invalid configuration", () => {
    const inbox = createSteeringInbox({ maxFieldBytes: 4 });
    expect(inbox.open("abcde", "1").status).toBe("invalid_target");
    expect(inbox.open("run", " ").status).toBe("invalid_target");
    const target = open(inbox);
    expect(target.claim("").status).toBe("invalid_boundary");
    const valid = { id: "a", sourceRef: "ref", sourceRevision: "1" };
    for (const bad of [
      { ...valid, id: " " },
      { ...valid, sourceRef: "ああ" },
      { ...valid, sourceRevision: "" },
      { ...valid, expiresAt: -1 },
      { ...valid, expiresAt: Number.NaN },
      { ...valid, expiresAt: 1.5 },
    ]) {
      expect(target.enqueue(bad).status).toBe("invalid_event");
    }
    expect(
      target.enqueue(null as unknown as ReturnType<typeof event>).status,
    ).toBe("invalid_event");
    expect(
      target.enqueue({ id: "🙂", sourceRef: "ref", sourceRevision: "1" })
        .status,
    ).toBe("accepted");
    expect(() => createSteeringInbox({ maxTargets: 0 })).toThrow(RangeError);
    expect(() => createSteeringInbox({ defaultTtlMs: 2, maxTtlMs: 1 })).toThrow(
      RangeError,
    );
    const brokenClock = open(createSteeringInbox({ now: () => -1 }));
    expect(() => brokenClock.claim("boundary")).toThrow(RangeError);
  });

  test("rejects a non-function clock at construction", () => {
    for (const now of [5, null]) {
      expect(() =>
        createSteeringInbox({ now: now as unknown as () => number }),
      ).toThrow(TypeError);
    }
  });
});
