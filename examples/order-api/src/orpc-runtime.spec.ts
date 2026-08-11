import assert from "node:assert/strict";

import { Module, Port, Provider, type Scope, type ServiceOf } from "@btravstack/di";
import { start, type RunningApp } from "@btravstack/start";
import {
  ApplicationModule,
  FindOrder,
  Logger,
  OrderRepository,
  PlaceOrder,
} from "@btravstack/start-example-order-application";
import { placeOrder, type Order } from "@btravstack/start-example-order-domain";
import { isInferableError, ORPCError } from "@orpc/client";
import { OkAsync, fromSafePromise } from "unthrown";
import { describe, expect, test } from "vitest";

import { createOrderApiClient, type OrderApiClient } from "./client.js";
import { OrderApiModule } from "./module.js";
import { orpcRuntime, type OrderApiInfo } from "./orpc-runtime.js";

type App<E> = RunningApp<E, OrderApiInfo>;

const anOrder = (id: string, quantity: number): Order => placeOrder(id, quantity).getOrThrow();

/**
 * Every spec binds `port: 0` and reads the port back from `Serving.info` — the
 * kernel's own channel for it, which is why this runtime has no `onListening`
 * hook and no `boundPort()` accessor of its own.
 */
const originOf = async <E>(app: App<E>): Promise<string> => {
  const info = (await app.runtimeInfo()).get();
  assert.ok(info !== undefined, "the runtime published no Serving.info");
  return `http://127.0.0.1:${info.port}`;
};

const clientFor = async <E>(app: App<E>): Promise<OrderApiClient> =>
  createOrderApiClient(await originOf(app));

/** Consumes the exit `Result` rather than awaiting and dropping it. */
const shutdown = async <E>(app: App<E>): Promise<void> => {
  app.stop();
  await expect(app.exited).toBeOk();
};

/**
 * `X` is pinned to the three ports the runtime declares rather than left
 * generic: `start`'s needs gate is a phantom rest parameter proven at the call
 * site, and no proof is available inside a helper generic in the module's own
 * exports.
 */
type ApiPorts = PlaceOrder | FindOrder | Logger;

const serve = <E>(
  module: Module<ApiPorts, E, Scope>,
  options?: { readonly drainTimeoutMs?: number },
) =>
  start(module, {
    runtime: orpcRuntime({ port: 0 }),
    signals: false,
    probes: false,
    preDrainDelayMs: 0,
    ...options,
  });

// --- fixtures -----------------------------------------------------------------

/**
 * A composition root shaped like the real one but with the repository swapped:
 * same `ApplicationModule`, same runtime, same three exported ports, so the
 * transport under test is unchanged.
 */
const apiOver = <E, N>(persistence: Module<OrderRepository, E, N>) =>
  Module("StubApi")({
    imports: [ApplicationModule, persistence],
    provides: [],
    exports: [PlaceOrder, FindOrder, Logger],
  });

const persistenceOf = (repository: ServiceOf<OrderRepository>) =>
  Module("StubPersistence")({
    provides: [Provider(OrderRepository)({ value: repository })],
    exports: [OrderRepository],
  });

/**
 * A repository whose `find` never settles until `release()` is called, and
 * whose `arrived` promise reports the moment the request reached it. Both drain
 * specs turn on knowing a unit is genuinely in flight before the drain starts —
 * polling a wall clock instead would be the flake.
 */
const gatedPersistence = () => {
  let entered!: () => void;
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    module: persistenceOf({
      save: (order) => OkAsync(order),
      find: (id) => {
        entered();
        return fromSafePromise(held.then(() => anOrder(id, 1)));
      },
    }),
    arrived,
    release: () => release(),
  };
};

/**
 * `start` hands the application context to the runtime alone, so a spec cannot
 * reach `Logger` the way `Module.scoped` can. This publishes the very `Logger`
 * service instance the use cases and the request scope write to.
 */
class LoggerTap extends Port("LoggerTap")<{ readonly lines: () => readonly string[] }> {}

const tappedApi = () => {
  let read: () => readonly string[] = () => [];

  return {
    module: Module("TappedApi")({
      imports: [OrderApiModule],
      provides: [
        Provider(LoggerTap)([Logger], {
          sync: (logger) => {
            read = logger.lines;
            return { lines: logger.lines };
          },
        }),
      ],
      exports: [PlaceOrder, FindOrder, Logger],
    }),
    traces: () => read().map((line) => line.slice(0, line.indexOf("]") + 1)),
  };
};

const statusOf = async (url: string): Promise<number> => (await fetch(url)).status;

// --- specs --------------------------------------------------------------------

describe("orpcRuntime", () => {
  test("carries a real oRPC call through to the DI-wired use case", async () => {
    const app = serve(OrderApiModule);

    try {
      const client = await clientFor(app);

      await expect(client.orders.place({ id: "o-1", quantity: 2 })).toBeOkWith({
        id: "o-1",
        quantity: 2,
      });
      // A second request, a second unit — and the same database, because the
      // application scope is opened once by the kernel and only the request
      // scope is forked per call.
      await expect(client.orders.find({ id: "o-1" })).toBeOkWith({ id: "o-1", quantity: 2 });
    } finally {
      await shutdown(app);
    }
  });

  test("publishes the bound port on Serving.info", async () => {
    const app = serve(OrderApiModule);

    try {
      await expect(app.runtimeInfo()).toBeOkWith({ port: expect.any(Number), prefix: "/rpc" });
    } finally {
      await shutdown(app);
    }
  });

  test("turns a domain Err into a typed, inferable ORPCError — a value, not a thrown 500", async () => {
    const app = serve(OrderApiModule);

    try {
      const client = await clientFor(app);
      await expect(client.orders.place({ id: "o-1", quantity: 1 })).toBeOk();

      const conflict = await client.orders.place({ id: "o-1", quantity: 1 });

      // The `Err` channel, not the defect one: the client got a value back.
      expect(conflict).toBeErr();
      if (conflict.isErr()) {
        expect(conflict.error).toBeInstanceOf(ORPCError);
        expect(conflict.error.code).toBe("CONFLICT");
        expect(conflict.error.data).toEqual({ id: "o-1" });
        // What "typed end to end" means at runtime: oRPC marks a returned,
        // declared error inferable, which is why it is an `Err` and not a
        // `Defect` collapsed to INTERNAL_SERVER_ERROR.
        expect(isInferableError(conflict.error)).toBe(true);
      }

      const invalid = await client.orders.place({ id: "o-2", quantity: 0 });

      expect(invalid).toBeErr();
      if (invalid.isErr()) {
        expect(invalid.error.code).toBe("INVALID_QUANTITY");
        expect(invalid.error.data).toEqual({ id: "o-2" });
      }

      // Each code is reachable from the client's own exhaustive match — the
      // mirror of the `mapErrCases` that produced it.
      const named = invalid.match({
        ok: () => "ok",
        errCases: (matcher) =>
          matcher
            .with({ code: "INVALID_QUANTITY" }, (error) => error.code)
            .with({ code: "CONFLICT" }, (error) => error.code),
        defect: () => "defect",
      });
      expect(named).toBe("INVALID_QUANTITY");
    } finally {
      await shutdown(app);
    }
  });

  test("collapses a Defect to INTERNAL_SERVER_ERROR and keeps serving", async () => {
    const app = serve(
      apiOver(
        persistenceOf({
          save: (order) => OkAsync(order),
          // An unmodelled failure: no `qualify` triaged it, so it is a defect
          // and never reaches the contract's declared error map.
          find: () => fromSafePromise(Promise.reject(new Error("the database is on fire"))),
        }),
      ),
    );

    try {
      const client = await clientFor(app);

      const result = await client.orders.find({ id: "o-1" });

      // The raw cause must NOT leak over the wire; oRPC collapses it, and the
      // non-inferable result lands back in the defect channel.
      expect(result).toBeDefectWith(expect.objectContaining({ code: "INTERNAL_SERVER_ERROR" }));
      if (result.isDefect()) expect(isInferableError(result.cause)).toBe(false);

      // A defect is not a crash: the process is still serving.
      expect(app.phase()).toBe("serving");
      await expect(client.orders.place({ id: "o-1", quantity: 1 })).toBeOk();
    } finally {
      await shutdown(app);
    }
  });

  test("runs each call in its own unit, with its own trace id", async () => {
    const tapped = tappedApi();
    const app = serve(tapped.module);

    try {
      const client = await clientFor(app);

      await expect(client.orders.place({ id: "o-1", quantity: 1 })).toBeOk();
      await expect(client.orders.place({ id: "o-2", quantity: 1 })).toBeOk();

      const traces = tapped.traces();
      // Two calls, two interactor lines plus two request-scope teardown lines.
      expect(traces).toHaveLength(4);
      expect(new Set(traces).size).toBe(2);
      expect(traces).not.toContain("[-]");
    } finally {
      await shutdown(app);
    }
  });

  test("lets an in-flight call finish while draining", async () => {
    const gate = gatedPersistence();
    const app = serve(apiOver(gate.module));
    const client = await clientFor(app);

    const inFlight = client.orders.find({ id: "o-1" });
    await gate.arrived;

    app.requestDrain();
    // The drain samples `inFlightAtStart` in the same synchronous turn that
    // advances the phase, so releasing only once the phase has moved is what
    // makes the report below exact rather than racy.
    await expect.poll(() => app.phase()).toBe("draining");
    gate.release();

    await expect(inFlight).toBeOkWith({ id: "o-1", quantity: 1 });
    await expect(app.exited).toBeOkWith(
      expect.objectContaining({ drain: { inFlightAtStart: 1, completed: 1, abandoned: 0 } }),
    );
  });

  test("reports a call still hung at the deadline as abandoned", async () => {
    const gate = gatedPersistence();
    const app = serve(apiOver(gate.module), { drainTimeoutMs: 0 });
    const client = await clientFor(app);

    // Never released: the unit is still open when the deadline passes.
    const hung = client.orders.find({ id: "o-1" });
    await gate.arrived;

    app.requestDrain();

    await expect(app.exited).toBeOkWith(
      expect.objectContaining({ drain: { inFlightAtStart: 1, completed: 0, abandoned: 1 } }),
    );
    // `stop` destroyed the socket under the abandoned call, so the client's own
    // `Result` is a defect — consumed here rather than left floating. The cause
    // is the fetch stack's own transport error, whose exact shape is not ours.
    await expect(hung).toBeDefectWith(expect.any(Error));
  });

  test("answers probes alongside the runtime, and goes unready on drain", async () => {
    const gate = gatedPersistence();
    const app = start(apiOver(gate.module), {
      runtime: orpcRuntime({ port: 0 }),
      signals: false,
      probes: { port: 0 },
      preDrainDelayMs: 0,
    });

    const probePort = (await app.probePort()).get();
    assert.ok(probePort !== undefined, "the probe server published no port");
    const probes = `http://127.0.0.1:${probePort}`;
    const client = await clientFor(app);

    expect(await statusOf(`${probes}/livez`)).toBe(200);
    expect(await statusOf(`${probes}/readyz`)).toBe(200);
    expect(app.ready()).toBe(true);

    const inFlight = client.orders.find({ id: "o-1" });
    await gate.arrived;

    app.requestDrain();

    // The TRANSITION is asserted through `ready()`, which is synchronously
    // readable — polling `/readyz` for it races the app exiting out from under
    // the probe server, and `expect.poll` fails outright when its callback
    // throws. The endpoint is then read exactly once, in a state that is stable
    // because the held call keeps the drain (and the process) alive.
    await expect.poll(() => app.ready()).toBe(false);
    expect(await statusOf(`${probes}/readyz`)).toBe(503);
    expect(await statusOf(`${probes}/livez`)).toBe(200);

    gate.release();
    await expect(inFlight).toBeOk();
    await expect(app.exited).toBeOk();
  });
});
