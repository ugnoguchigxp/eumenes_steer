import { expect, test } from "bun:test";
import { createSteeringInbox, type SteeringEvent } from "eumenes-steer";
import { answerAfterRead } from "../example/agent-loop.ts";

test("the next existing model input gets the ordered supplements while work continues", async () => {
  const opened = createSteeringInbox().open("task", "1");
  if (opened.status !== "opened") throw new Error(opened.status);
  const { target } = opened;
  const sources = new Map([
    ["existing", "already in context"],
    ["ref-a", "first supplement"],
    ["ref-b", "second supplement"],
    ["revoked", "deleted before handoff"],
  ]);
  const existing = { id: "prior", sourceRef: "existing", sourceRevision: "1" };
  const inputs: (readonly string[])[] = [];
  let finishRead: (result: readonly SteeringEvent[]) => void = () => {
    throw new Error("read has not started");
  };
  const answering = answerAfterRead(
    target,
    () =>
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    (event) => sources.get(event.sourceRef),
    (supplements) => {
      inputs.push(supplements);
      expect(target.enqueue({ ...existing, id: "too-late" }).status).toBe(
        "sealed",
      );
      return "committed";
    },
  );
  expect(target.enqueue({ ...existing, id: "duplicate-source" }).status).toBe(
    "accepted",
  );
  expect(
    target.enqueue({ id: "a", sourceRef: "ref-a", sourceRevision: "1" }).status,
  ).toBe("accepted");
  expect(
    target.enqueue({ id: "b", sourceRef: "ref-b", sourceRevision: "1" }).status,
  ).toBe("accepted");
  expect(
    target.enqueue({ id: "c", sourceRef: "revoked", sourceRevision: "1" })
      .status,
  ).toBe("accepted");
  expect(inputs).toEqual([]);
  sources.delete("revoked");
  finishRead([existing]);
  await answering;
  expect(inputs).toEqual([["first supplement", "second supplement"]]);
  expect(target.claim("later").status).toBe("closed");
});

test("the model still receives its regular input when there are no supplements", async () => {
  const opened = createSteeringInbox().open("task", "1");
  if (opened.status !== "opened") throw new Error(opened.status);
  const inputs: (readonly string[])[] = [];
  await answerAfterRead(
    opened.target,
    async () => [],
    () => undefined,
    (supplements) => {
      inputs.push(supplements);
      return "committed";
    },
  );
  expect(inputs).toEqual([[]]);
  expect(opened.target.claim("later").status).toBe("closed");
});
