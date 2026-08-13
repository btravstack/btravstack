import { Ok, fromSafePromise } from "unthrown";
import { expect, test, vi } from "vitest";

import { Module, Port, Provider } from "./index.js";

class Server extends Port("LServer")<{ readonly port: number }> {}
class Worker extends Port("LWorker")<{ readonly name: string }> {}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("onStart runs after the whole graph is built, in declaration order", async () => {
  const events: string[] = [];
  const mod = Module("Lifecycle")({
    provides: [
      Provider(Server)({
        value: { port: 8080 },
        onStart: (s) => void events.push(`start-server-${s.port}`),
      }),
      Provider(Worker)([Server], {
        sync: () => ({ name: "w" }),
        onStart: (w) => void events.push(`start-${w.name}`),
      }),
    ],
    exports: [Server, Worker],
  });

  await Module.scoped(mod, () => Ok("ran").toAsync());
  expect(events).toEqual(["start-server-8080", "start-w"]);
});

test("onStop runs in reverse declaration order during teardown", async () => {
  const events: string[] = [];
  const mod = Module("Lifecycle")({
    provides: [
      Provider(Server)({
        value: { port: 1 },
        onStop: () => void events.push("stop-server"),
      }),
      Provider(Worker)([Server], {
        sync: () => ({ name: "w" }),
        onStop: () => void events.push("stop-worker"),
      }),
    ],
    exports: [Server, Worker],
  });

  await Module.scoped(mod, () => Ok("ran").toAsync());
  expect(events).toEqual(["stop-worker", "stop-server"]);
});

test("Module.scoped runs an onStop registered with no acquire/release at all", async () => {
  let stopped = false;
  const mod = Module("OnStopOnly")({
    provides: [
      Provider(Server)({
        value: { port: 1 },
        onStop: () => {
          stopped = true;
        },
      }),
    ],
    exports: [Server],
  });

  await Module.scoped(mod, () => Ok("ran").toAsync());
  expect(stopped).toBe(true);
});

test("release and onStop interleave in one combined LIFO unwind, not two separate passes", async () => {
  const events: string[] = [];
  const mod = Module("Lifecycle")({
    provides: [
      Provider(Server)({
        value: { port: 1 },
        onStop: () => void events.push("server-onStop"),
      }),
      Provider(Worker)([Server], {
        acquire: () => Ok({ name: "w" }),
        release: () => void events.push("worker-release"),
        onStop: () => void events.push("worker-onStop"),
      }),
    ],
    exports: [Server, Worker],
  });

  await Module.scoped(mod, () => Ok("ran").toAsync());
  // Worker (built second) unwinds before Server (built first); within
  // Worker, its own `onStop` and `release` are adjacent — `onStop` first,
  // since it is registered on the scope right after `release` and the scope
  // unwinds LIFO — not grouped by kind across providers (which would give
  // the wrong ["worker-onStop", "server-onStop", "worker-release"] or
  // similar "two passes" order).
  expect(events).toEqual(["worker-onStop", "worker-release", "server-onStop"]);
});

test("an async onStart is genuinely awaited before use runs", async () => {
  const events: string[] = [];
  const mod = Module("Lifecycle")({
    provides: [
      Provider(Server)({
        value: { port: 1 },
        onStart: async () => {
          await delay(10);
          events.push("start");
        },
      }),
    ],
    exports: [Server],
  });

  await Module.scoped(mod, () => {
    events.push("use");
    return Ok("ran").toAsync();
  });
  // If `onStart`'s promise were discarded (`void provider.onStart!(service)`
  // on a value that happens to be a `Promise`) rather than awaited, `use`
  // would run on the very next microtask — before the 10ms delay resolves —
  // and this would observe `["use", "start"]` instead.
  expect(events).toEqual(["start", "use"]);
});

test("a throwing onStart surfaces as a Defect, use is skipped, and teardown still runs", async () => {
  const events: string[] = [];
  const useRan = vi.fn();
  const mod = Module("Lifecycle")({
    provides: [
      Provider(Server)({
        acquire: () => Ok({ port: 1 }),
        release: () => void events.push("release"),
        // `async` on purpose, not a plain synchronous throw: `.map`'s
        // callback already catches a *synchronous* throw regardless of
        // whether its result is awaited, so a sync throw here would not
        // distinguish this implementation from one that discards onStart's
        // return value — an async rejection only becomes a Defect if it is
        // genuinely awaited.
        onStart: async () => {
          // Deliberate: this test exists specifically to prove a rejecting
          // onStart becomes a Defect rather than an unhandled rejection.
          // oxlint-disable-next-line unthrown/no-throw
          throw new Error("onStart boom");
        },
      }),
    ],
    exports: [Server],
  });

  const result = await Module.scoped(mod, () => {
    useRan();
    return Ok("ran").toAsync();
  });

  expect(result).toBeDefect();
  expect(useRan).not.toHaveBeenCalled();
  // `runStartHooks` fires only after the whole graph is built, so `release`
  // was already registered on the scope by the time `onStart` threw —
  // teardown still unwinds it.
  expect(events).toEqual(["release"]);
});

test("declaration order holds even when an earlier same-level provider resolves later", async () => {
  const events: string[] = [];
  const mod = Module("Lifecycle")({
    provides: [
      // Declared first, but its construct resolves *last* — the exact
      // shape the brief's `.tap`-order sketch got wrong: a push inside
      // `constructLevel`'s `.tap` fires per-provider as each one settles,
      // so Worker (which resolves first) would have landed in `started`
      // before Server there, running its `onStart` first despite being
      // declared second.
      Provider(Server)({
        make: () => fromSafePromise(delay(20)).flatMap(() => Ok({ port: 1 })),
        onStart: () => void events.push("server"),
      }),
      // Declared second, resolves first.
      Provider(Worker)({
        make: () => fromSafePromise(delay(1)).flatMap(() => Ok({ name: "w" })),
        onStart: () => void events.push("worker"),
      }),
    ],
    exports: [Server, Worker],
  });

  await Module.scoped(mod, () => Ok("ran").toAsync());
  expect(events).toEqual(["server", "worker"]);
});
