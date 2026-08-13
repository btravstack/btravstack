import { OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("amqpRuntime", () => {
  it("publishes the queues it drains", async ({ serve }) => {
    // GIVEN a worker consuming the test contract's one queue
    const app = await serve(() => ({ echo: () => OkAsync(undefined) }));

    // WHEN the kernel is asked what the runtime published about itself
    const info = app.runtimeInfo();

    // THEN it is the set of queues an operator would look at in the
    // management UI, derived from the contract rather than from an option that
    // could disagree with it
    await expect(info).toBeOkWith({ queues: ["start-amqp-echo"] });
  });

  // `TypedAmqpWorker.create`'s own `connectTimeoutMs` default (30s) is what
  // this test waits out — see the comment in `test-fixtures.ts`'s
  // `serveBroken` — hence the raised per-test timeout below.
  it("reports a broker that will not answer as Err, not a defect", async ({ serveBroken }) => {
    // GIVEN a URL nothing is listening on
    const app = await serveBroken();

    // WHEN the application is started
    // THEN it never comes up, and the failure is the kernel's own modeled Err
    // rather than an unmodelled Defect. `TypedAmqpWorker.create` reports a
    // connection failure on the DEFECT channel with a `TechnicalError` cause;
    // dropping the `recoverDefect` in `createWorker` turns every unreachable
    // broker into `runMain` exit 70 where a startup failure earns 1.
    await expect(app.exited).toBeErrTagged(
      "RuntimeStartFailed",
      expect.objectContaining({ runtime: "amqp" }),
    );
  }, 35_000);
});
