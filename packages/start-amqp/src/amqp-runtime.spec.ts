import { OkAsync } from "unthrown";
import { describe, expect, vi } from "vitest";

import { it } from "./test-fixtures.js";

describe("amqpRuntime", () => {
  it("publishes the queues it drains", async ({ serve }) => {
    // GIVEN a worker consuming the test contract's one queue
    const app = await serve(() => ({
      handlers: { echo: () => OkAsync(undefined) },
      middleware: undefined,
    }));

    // WHEN the kernel is asked what the runtime published about itself
    const info = app.runtimeInfo();

    // THEN it is the set of queues an operator would look at in the
    // management UI, derived from the contract rather than from an option that
    // could disagree with it
    await expect(info).toBeOkWith({ queues: ["start-amqp-echo"] });
  });

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
  });

  it("opens one kernel unit per delivery", async ({ serve, seam, publishMessage }) => {
    // GIVEN a worker whose handler runs inside the middleware
    await serve(seam.build);

    // WHEN one message is published with an id of the publisher's own
    publishMessage(
      { exchange: "start-amqp-test", routingKey: "echo.requested" },
      { value: "x" },
      { messageId: "m-1" },
    );
    await vi.waitUntil(() => seam.seen().length === 1);

    // THEN the delivery ran inside a unit whose id is minted here — a delivery
    // tag restarts at 1 after a reconnect and cannot carry the kernel's
    // uniqueness rule — and whose traceId is the publisher's message id,
    // stable across every redelivery
    expect(seam.seen()).toEqual([{ kind: "delivery", id: expect.any(String), traceId: "m-1" }]);
  });

  it("injects the application context through the contract's own channel", async ({
    serve,
    seam,
    publishMessage,
  }) => {
    // GIVEN the same wiring
    await serve(seam.build);

    // WHEN one message is delivered
    publishMessage({ exchange: "start-amqp-test", routingKey: "echo.requested" }, { value: "x" });
    await vi.waitUntil(() => seam.greeting() !== "");

    // THEN the handler reached the DI graph without the package inventing a
    // channel of its own — which is what makes the seam cost one line
    expect(seam.greeting()).toBe("hello");
  });

  it("lets an in-flight delivery finish while draining", async ({
    serve,
    gate,
    publishMessage,
  }) => {
    // GIVEN a delivery held open inside the application
    const app = await serve(gate.build);
    publishMessage({ exchange: "start-amqp-test", routingKey: "echo.requested" }, { value: "x" });
    await gate.arrived;

    // WHEN the drain starts and the handler is released once the phase moved.
    // `vi.waitUntil` synchronises rather than asserts — the drain samples
    // `inFlightAtStart` in the same synchronous turn that advances the phase.
    app.requestDrain();
    await vi.waitUntil(() => app.phase() === "draining");
    gate.release();

    // THEN the kernel counted it as one unit that COMPLETED, through a real
    // broker round trip
    await expect(app.exited).toBeOkWith(
      expect.objectContaining({ drain: { inFlightAtStart: 1, completed: 1, abandoned: 0 } }),
    );
  });

  it("releases the kernel at its own deadline, not the library's own close timeout", async ({
    serve,
    gate,
    publishMessage,
  }) => {
    // GIVEN a delivery that never finishes, and a drain with no time to give it.
    // `beginClose` passes `drainTimeoutMs: null`, so `worker.close()` itself
    // waits for this handler INDEFINITELY in the background — it is still
    // running, unreleased, when this test's assertion fires below.
    const app = await serve(gate.build, { drainTimeoutMs: 100 });
    publishMessage(
      { exchange: "start-amqp-test", routingKey: "echo.requested" },
      { value: "x" },
      { messageId: "m-hung" },
    );
    await gate.arrived;

    // WHEN the drain runs out of time. The kernel calls `drain(signal)` once
    // and, unconditionally, `stop()` again right after — and by the second
    // call `signal` is already aborted, since `drain.ts` aborts it the instant
    // its own race settles. That second call is `whenAborted`'s already-aborted
    // arm: `beginClose()`'s `closing` is still pending (the handler above is
    // still stuck), so if that arm regressed to always waiting for a fresh
    // `'abort'` event, this test would hang rather than settle promptly.
    const askedAt = Date.now();
    app.requestDrain();
    const report = await app.exited;

    // THEN the exit is not held hostage by a handler that cannot finish: the
    // delivery is reported abandoned and the process is released on the
    // kernel's own deadline rather than the library's own 30s
    // DEFAULT_DRAIN_TIMEOUT_MS. Redelivery is a real property of the broker
    // once the connection actually drops — see `releasedBy`'s TSDoc — but this
    // package's own `close()` call keeps waiting for this very handler in the
    // background (this test's `gate` fixture releases it in teardown, and the
    // library then acks it normally), so an unacked-message round trip is not
    // something this same-process test can observe; only the kernel's own
    // prompt release is.
    expect(
      report.map((exit) => ({ drain: exit.drain, promptly: Date.now() - askedAt < 5_000 })),
    ).toBeOkWith({
      drain: { inFlightAtStart: 1, completed: 0, abandoned: 1 },
      promptly: true,
    });
  });
});
