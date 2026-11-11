import { expect, test } from "bun:test";
import {
  createSteeringInbox,
  type SteeringBatchId,
  type SteeringOutcome,
} from "eumenes-steer";

function random(seed: number) {
  let state = seed >>> 0;
  return (limit: number) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return Math.floor((state / 0x1_0000_0000) * limit);
  };
}

const seeds = [1, 17, 131, 1021, 31337, 65537, 0xdeadbeef, 0xc0ffee];
const outcomes: readonly SteeringOutcome[] = [
  "released",
  "committed",
  "unknown",
];

test.each(seeds)("inbox invariants hold for seed %i", (seed) => {
  const pick = random(seed);
  const capacity = 4;
  let time = 0;
  const inbox = createSteeringInbox({
    now: () => time,
    maxPendingPerTarget: capacity,
  });
  const opened = inbox.open("target", "1");
  if (opened.status !== "opened") throw new Error(opened.status);
  const { target } = opened;

  // The model keeps an append-only acceptance log, even for expired events.
  // Eligibility is derived from the log at each operation.
  const records: {
    id: string;
    expiresAt: number;
    state: "waiting" | "held" | "done";
  }[] = [];
  const settledBoundaries = new Set<string>();
  const trace: unknown[] = [];
  let sealed = false;
  let active: { boundary: string; token: SteeringBatchId } | undefined;
  let retry: { boundary: string; ids: Set<string> } | undefined;
  const waiting = () =>
    records.filter(
      (record) => record.state === "waiting" && record.expiresAt > time,
    );
  const held = () => records.filter((record) => record.state === "held");

  try {
    for (let step = 0; step < 160; step++) {
      const operation = pick(12);
      if (operation < 5) {
        const previous =
          pick(6) === 0 ? records[pick(records.length)] : undefined;
        const id = previous?.id ?? `event-${step}`;
        const expiresAt = time + pick(20);
        trace.push(["enqueue", id, expiresAt]);
        const result = inbox.enqueue("target", "1", {
          id,
          sourceRef: id,
          sourceRevision: "1",
          expiresAt,
        });
        if (sealed) {
          expect(result.status).toBe("sealed");
        } else if (previous) {
          expect(result.status).toBe("duplicate");
        } else if (expiresAt === time) {
          expect(result.status).toBe("expired");
        } else if (waiting().length + held().length === capacity) {
          expect(result.status).toBe("pending_limit");
        } else {
          expect(result.status).toBe("accepted");
          records.push({ id, expiresAt, state: "waiting" });
        }
      } else if (operation < 8) {
        const boundary =
          (pick(2) === 0 ? retry?.boundary : undefined) ??
          `boundary-${pick(12)}`;
        trace.push(["claim", boundary]);
        const result = target.claim(boundary);
        if (active) {
          expect(result.status).toBe("busy");
        } else if (settledBoundaries.has(boundary)) {
          expect(result.status).toBe("boundary_settled");
        } else {
          const retried = retry?.boundary === boundary ? retry.ids : undefined;
          const expected = waiting().filter(
            ({ id }) => !retried || retried.has(id),
          );
          if (expected.length === 0) {
            expect(result.status).toBe("empty");
          } else {
            if (result.status !== "claimed") throw new Error(result.status);
            expect(
              result.batch.events.map(({ id, expiresAt }) => ({
                id,
                expiresAt,
              })),
            ).toEqual(expected.map(({ id, expiresAt }) => ({ id, expiresAt })));
            for (const record of expected) record.state = "held";
            active = { boundary, token: result.batch.id };
            retry = undefined;
          }
        }
      } else if (operation < 10) {
        const outcome = outcomes[pick(outcomes.length)]!;
        trace.push(["settle", outcome]);
        if (active) {
          expect(target.settle(active.token, outcome)).toBe("settled");
          const batch = held();
          if (outcome === "released") {
            retry = {
              boundary: active.boundary,
              ids: new Set(batch.map(({ id }) => id)),
            };
          } else {
            settledBoundaries.add(active.boundary);
          }
          for (const record of batch)
            record.state = outcome === "released" ? "waiting" : "done";
          active = undefined;
        } else {
          expect(target.settle(Symbol(), outcome)).toBe("stale");
        }
      } else if (operation === 10 && step >= 120) {
        trace.push(["seal"]);
        expect(target.seal()).toBe("sealed");
        sealed = true;
      } else {
        const elapsed = pick(8);
        trace.push(["advance", elapsed]);
        time += elapsed;
      }
      expect(waiting().length + held().length).toBeLessThanOrEqual(capacity);
    }
    trace.push(["close"]);
    expect(target.close()).toBe(
      records.filter(({ state }) => state !== "done").length,
    );
    expect(target.close()).toBe(0);
  } catch (error) {
    throw new Error(`seed ${seed}, operations ${JSON.stringify(trace)}`, {
      cause: error,
    });
  }
});
