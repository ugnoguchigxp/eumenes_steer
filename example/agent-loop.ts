import type {
  SteeringEvent,
  SteeringOutcome,
  SteeringTarget,
} from "eumenes-steer";

export async function answerAfterRead(
  target: SteeringTarget,
  read: () => Promise<readonly SteeringEvent[]>,
  resolve: (event: SteeringEvent) => string | undefined,
  handoff: (supplements: readonly string[]) => SteeringOutcome,
) {
  try {
    const existing = await read();
    const key = ({ sourceRef, sourceRevision }: SteeringEvent) =>
      JSON.stringify([sourceRef, sourceRevision]);
    const shown = new Set(existing.map(key));
    target.seal();
    const claimed = target.claim("answer");
    if (claimed.status === "empty") {
      handoff([]);
      return;
    }
    if (claimed.status !== "claimed") throw new Error(claimed.status);

    const supplements: string[] = [];
    for (const event of claimed.batch.events) {
      const ref = key(event);
      if (event.expiresAt <= Date.now() || shown.has(ref)) continue;
      const text = resolve(event);
      if (text === undefined) continue;
      shown.add(ref);
      supplements.push(text);
    }
    const outcome = handoff(supplements);
    target.settle(claimed.batch.id, outcome);
  } finally {
    target.close();
  }
}
