import { describe, expect, vi } from "vitest";

import { OrderWorkerModule } from "./module.js";
import { it } from "./test-fixtures.js";

describe("queueWorkerRuntime", () => {
  it("acks a job whose order the use case places", async ({ serve, queue, aJob }) => {
    // GIVEN the same composition the API boots — `ApplicationModule` and
    // `PersistenceModule`, unchanged — under a queue runtime instead
    serve(OrderWorkerModule);

    // WHEN a job is published
    // THEN it reached the use case behind the transport, and the message is done
    await expect(queue.publish(aJob("job-1", "o-1", 2))).toBeOkWith({
      jobId: "job-1",
      outcome: "acked",
      attempts: 1,
    });
  });

  it("dead-letters the DuplicateOrder the API answers CONFLICT for", async ({
    serve,
    queue,
    aJob,
  }) => {
    // GIVEN an order already placed by a first job
    serve(OrderWorkerModule);

    // WHEN a second job asks for the same order id — chained, so the first
    // job's settlement is consumed and a failure there cannot be mistaken for
    // the duplicate. A second job is a second unit, over the same database:
    // the application scope is opened once, by the kernel.
    const settled = await queue
      .publish(aJob("job-1", "o-1", 2))
      .flatMap(() => queue.publish(aJob("job-2", "o-1", 2)));

    // THEN the load-bearing assertion of this whole example: the identical
    // `Err` the oRPC runtime turns into an inferable CONFLICT is parked here,
    // because a queue has no caller waiting to be told. One `Result`, two
    // transports, and the kernel involved in neither mapping.
    expect(settled).toBeOkWith({
      jobId: "job-2",
      outcome: "dead-lettered",
      reason: "DuplicateOrder",
      attempts: 1,
    });
  });

  it("dead-letters a job the domain rejects, rather than redelivering it", async ({
    serve,
    queue,
    aJob,
  }) => {
    // GIVEN a quantity the domain invariant rejects
    serve(OrderWorkerModule);

    // WHEN the job is published
    // THEN it is parked on the first attempt: a redelivery would ask the same
    // impossible thing again
    await expect(queue.publish(aJob("job-1", "o-1", 0))).toBeOkWith({
      jobId: "job-1",
      outcome: "dead-lettered",
      reason: "InvalidQuantity",
      attempts: 1,
    });
  });

  it("redelivers an unmodelled failure, then parks it once the attempts run out", async ({
    serve,
    queue,
    aJob,
    unmodelled,
  }) => {
    // GIVEN a repository whose failure nobody modelled, so it is a `Defect`
    serve(unmodelled);

    // WHEN a job reaches it
    // THEN the third channel takes the third route: infrastructure comes back,
    // so a defect is worth another delivery — three of them, and then the
    // message is parked carrying the cause
    await expect(queue.publish(aJob("job-1", "o-1", 1))).toBeOkWith({
      jobId: "job-1",
      outcome: "dead-lettered",
      reason: "Error: the database is on fire",
      attempts: 3,
    });
  });

  it("publishes the queue it consumes on Serving.info", async ({ serve }) => {
    // GIVEN a worker consuming the fixture's queue
    const app = serve(OrderWorkerModule);

    // WHEN the kernel is asked what the runtime published about itself
    const info = app.runtimeInfo();

    // THEN the same channel the API publishes `{ port, prefix }` on carries a
    // shape with no port in it at all
    await expect(info).toBeOkWith({ queue: "orders", concurrency: 1 });
  });

  it("runs each job in its own unit, with its own trace id", async ({
    serve,
    queue,
    aJob,
    tapped,
  }) => {
    // GIVEN the real graph with the very `Logger` instance the use cases and
    // the disposition write to
    serve(tapped.worker);

    // WHEN two jobs are consumed — chained, so neither settlement is dropped
    const settled = await queue
      .publish(aJob("job-1", "o-1", 1))
      .flatMap(() => queue.publish(aJob("job-2", "o-2", 1)));

    // THEN two jobs, two interactor lines plus two disposition lines, each
    // carrying the message id its delivery correlated to and never the
    // out-of-unit `[-]`. The unit id is `job-1#1`, the trace id is `job-1`:
    // a redelivery is a new unit and the same trace.
    expect(settled.map(() => tapped.traces())).toBeOkWith([
      "[job-1]",
      "[job-1]",
      "[job-2]",
      "[job-2]",
    ]);
  });

  it("never settles a job published with no worker running", async ({
    queue,
    aJob,
    withinATurn,
  }) => {
    // GIVEN a job published with nothing serving — no `serve`, so nothing will
    // ever claim it
    const published = queue.publish(aJob("job-1", "o-1", 1));

    // WHEN it is given a full turn to settle
    const outcome = await withinATurn(published);

    // THEN it is still pending, which is the precondition `publish` documents:
    // a settlement comes from a *worker*, and the attempt budget bounds the
    // retries of a claimed job, not the wait for a claim. Awaiting it here
    // would hang the suite — racing a turn is what makes it a failure instead
    expect(outcome).toBe("unsettled");
  });

  it("leaves a job the drain never claimed unsettled, without waiting for it", async ({
    serve,
    queue,
    aJob,
    gate,
    withinATurn,
  }) => {
    // GIVEN a worker at its concurrency limit — one delivery held open inside
    // the repository, and a second job queued behind it
    const app = serve(gate.worker);
    const held = queue.publish(aJob("job-1", "o-1", 1));
    await gate.arrived;
    const queued = queue.publish(aJob("job-2", "o-2", 1));

    // WHEN the drain runs to completion, the in-flight delivery released only
    // once the phase moved
    app.requestDrain();
    await vi.waitUntil(() => app.phase() === "draining");
    gate.release();
    await vi.waitUntil(() => app.phase() === "exited");

    // THEN the drain waited for the delivery it had claimed and not for the one
    // it had not: `Serving.drain` stops claiming, so an unclaimed message stays
    // in the queue for the next worker — and this producer waits forever
    expect({ inFlight: await withinATurn(held), unclaimed: await withinATurn(queued) }).toEqual({
      inFlight: "settled",
      unclaimed: "unsettled",
    });
  });

  it("waits for the in-flight job while draining", async ({ serve, queue, aJob, gate }) => {
    // GIVEN a job held open inside the repository
    const app = serve(gate.worker);
    const settled = queue.publish(aJob("job-1", "o-1", 1));
    await gate.arrived;

    // WHEN the drain starts and the job is released only once the phase moved.
    // `vi.waitUntil` synchronises rather than asserts — the drain samples
    // `inFlightAtStart` in the same synchronous turn that advances the phase,
    // so releasing afterwards is what makes the report exact rather than racy.
    app.requestDrain();
    await vi.waitUntil(() => app.phase() === "draining");
    gate.release();

    // THEN the drain waited for the delivery to be acked — read through the
    // settlement, so its own `Result` is consumed and a job that never settled
    // could not be reported as completed
    const report = await settled.flatMap(() => app.exited);

    expect(report).toBeOkWith(
      expect.objectContaining({ drain: { inFlightAtStart: 1, completed: 1, abandoned: 0 } }),
    );
  });
});
