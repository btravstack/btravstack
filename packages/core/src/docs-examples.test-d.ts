// Every code sample the root `README.md` and `packages/core/README.md` ship,
// compiled. A sample that stops compiling fails `pnpm typecheck`.
//
// The one deliberate divergence from the published text: the samples import
// from `./index.js` / `./testing.js` where a reader imports `@btravstack/core`
// and `@btravstack/core/testing`. The package cannot resolve its own name from
// inside its own source tree, and those two specifiers are exactly what
// `package.json`'s `exports` map points at.

import { Module, Port, Provider, type AnyPort, type Context } from "@btravstack/di";
// The matcher augmentation `src/vitest.d.ts` carries for the specs: this
// config compiles `*.test-d.ts` alone, so the testing sample below needs it in
// scope to spell `toBeOkWith`.
import type {} from "@unthrown/vitest";
import { Ok, OkAsync, P, type AsyncResult, type Result } from "unthrown";
import { expect, expectTypeOf } from "vitest";

import {
  currentUnit,
  runMain,
  start,
  type DrainReport,
  type RunUnit,
  type Runtime,
  type RuntimeHost,
  type RuntimeStartFailed,
  type Serving,
  type UnitMeta,
} from "./index.js";
import { createFakeClock, testRuntime, withApp } from "./testing.js";

// ---------------------------------------------------------------------------
// "A worked example" — both READMEs.
// ---------------------------------------------------------------------------

class Greeter extends Port("Greeter")<{
  readonly greet: (name: string) => string;
}> {}

const AppModule = Module("App")({
  provides: [Provider(Greeter)({ value: { greet: (name: string) => `hello, ${name}` } })],
  exports: [Greeter],
});

// A runtime owns the transport; the kernel owns the lifecycle. This one is a
// timer, so the sample stays self-contained — no published runtime models a
// timer, and `@btravstack/http` would pull in a real dependency this
// sample doesn't need.
const ticker: Runtime<typeof Greeter> = {
  name: "ticker",
  needs: [Greeter],
  start: (host) => {
    const timer = setInterval(() => {
      // Every piece of work goes through `host.run`: that is what makes it
      // count towards the drain, and what gives it an `AbortSignal`.
      //
      // The unit's `Result` is the runtime's to map — the kernel hands it back
      // and stays out of it. A timer has nowhere to return one, so it observes
      // it instead; dropping it would hide the work's `Err` *and* a `Defect`.
      void host
        .run({ kind: "tick", id: `${Date.now()}` }, (ctx, signal) =>
          signal.aborted ? Ok("") : Ok(ctx.get(Greeter).greet("world")),
        )
        .tapFailure((failure) => {
          process.stderr.write(`${JSON.stringify({ tick: failure.tag })}\n`);
        });
    }, 1_000);

    const serving: Serving = {
      // Stop accepting new work. In-flight units are the kernel's business.
      drain: () => {
        clearInterval(timer);
        return OkAsync();
      },
      stop: () => OkAsync(),
    };

    return OkAsync(serving);
  },
};

await runMain(AppModule, { runtime: ticker });

// ---------------------------------------------------------------------------
// "Per-unit ports" — both READMEs and the root CLAUDE.md. `StartOptions.unit`
// is forked around every unit; its needs must be covered by the module's
// exports, or by `Scope` — which `onStop` puts in the unit module's NEEDS,
// and which the fork discharges by opening a scope, as `Module.forkScope`
// always does.
// ---------------------------------------------------------------------------

class TickSpan extends Port("TickSpan")<{ readonly finish: () => void }> {}

const TickModule = Module("Tick")({
  provides: [
    Provider(TickSpan)([Greeter], {
      sync: (greeter) => ({
        finish: () => process.stderr.write(`${greeter.greet("span")}\n`),
      }),
      onStop: (span) => span.finish(),
    }),
  ],
  exports: [TickSpan],
});

await runMain(AppModule, { runtime: ticker, unit: TickModule });

// ---------------------------------------------------------------------------
// "The Runtime contract" — root README. Asserted equal to the shipped types
// rather than merely compiled, so the README cannot drift from `runtime.ts`.
// ---------------------------------------------------------------------------

type ReadmeServing<Info = never> = {
  readonly drain: (signal: AbortSignal) => AsyncResult<void, never>;
  readonly stop: () => AsyncResult<void, never>;
  readonly info?: Info;
};

type ReadmeRuntime<Needs extends AnyPort, Info = never> = {
  readonly name: string;
  readonly needs: readonly Needs[];
  readonly start: (host: RuntimeHost<Needs>) => AsyncResult<Serving<Info>, RuntimeStartFailed>;
};

type ReadmeRuntimeHost<Needs extends AnyPort> = {
  readonly ctx: Context<InstanceType<Needs>>;
  readonly run: RunUnit<Needs>;
};

type ReadmeDrainReport = {
  readonly inFlightAtStart: number;
  readonly completed: number;
  readonly abandoned: number;
};

expectTypeOf<ReadmeServing>().toEqualTypeOf<Serving>();
expectTypeOf<ReadmeRuntime<typeof Greeter>>().toEqualTypeOf<Runtime<typeof Greeter>>();
expectTypeOf<ReadmeRuntimeHost<typeof Greeter>>().toEqualTypeOf<RuntimeHost<typeof Greeter>>();
expectTypeOf<ReadmeDrainReport>().toEqualTypeOf<DrainReport>();

// ---------------------------------------------------------------------------
// "What a runtime publishes about itself" — root README.
// ---------------------------------------------------------------------------

type HttpInfo = { readonly port: number };

const httpish: Runtime<typeof Greeter, HttpInfo> = {
  name: "httpish",
  needs: [Greeter],
  start: () =>
    OkAsync({
      drain: () => OkAsync(),
      stop: () => OkAsync(),
      // Whatever the runtime actually bound. A queue consumer has no port and
      // would publish `{ queue, prefetch }` instead — the shape is its own.
      info: { port: 8080 },
    }),
};

const app = start(AppModule, { runtime: httpish });
const info = await app.runtimeInfo(); // Result<HttpInfo | undefined, never>

expectTypeOf(info).toEqualTypeOf<Result<HttpInfo | undefined, never>>();

// ---------------------------------------------------------------------------
// "The unit of work" — root README.
// ---------------------------------------------------------------------------

const submitOne = (run: RunUnit<typeof Greeter>, meta: UnitMeta): AsyncResult<string, never> =>
  run(meta, (ctx, signal) => (signal.aborted ? Ok("") : Ok(ctx.get(Greeter).greet("world"))));

// ---------------------------------------------------------------------------
// "Two contracts a runtime owes" — root README.
// ---------------------------------------------------------------------------

const serveOne = (
  host: RuntimeHost<typeof Greeter>,
  meta: UnitMeta,
  send: (body: string) => Promise<void>,
): AsyncResult<string, never> =>
  // Flushed inside the work callback. Sending after `await host.run(...)`
  // returns is the race: the unit is already closed by then.
  host.run(meta, async (ctx, signal) => {
    const body = signal.aborted ? "" : ctx.get(Greeter).greet("world");
    await send(body);
    return Ok(body);
  });

// ---------------------------------------------------------------------------
// "Ambient carries data" — root README.
// ---------------------------------------------------------------------------

const log = (message: string): void => {
  const unit = currentUnit();
  process.stderr.write(`${JSON.stringify({ message, traceId: unit?.traceId })}\n`);
};

// ---------------------------------------------------------------------------
// "Embedding without runMain" — both READMEs. The footgun.
// ---------------------------------------------------------------------------

const embed = async (): Promise<void> => {
  const app = start(AppModule, { runtime: ticker, signals: true });
  const report = await app.exited;

  process.exitCode = report.match({
    ok: (exit) => (exit.reason === "uncaught" ? 70 : 0),
    errCases: (matcher) => matcher.with(P.tag("RuntimeStartFailed"), () => 1),
    defect: () => 70,
  });
};

// ---------------------------------------------------------------------------
// "Testing" — both READMEs.
// ---------------------------------------------------------------------------

const drainTest = async (): Promise<void> => {
  const clock = createFakeClock();
  const runtime = testRuntime();

  const report = await withApp(AppModule, { runtime, clock }, async (app) => {
    await runtime.untilStarted();
    const unit = runtime.submit<string>();

    app.requestDrain();
    await clock.advance(5_000); // the pre-drain delay

    unit.settle(Ok("done"));
    // The unit's own outcome, asserted rather than awaited for its timing
    // alone — a bare `await unit.result;` would drop it.
    expect(await unit.result).toBeOkWith("done");

    return await app.exited;
  });

  // `{ inFlightAtStart: 1, completed: 1, abandoned: 0 }` at runtime; the drain
  // slot is optional in the type because a non-signal exit skips the drain.
  expectTypeOf(report.getOrThrow().drain).toEqualTypeOf<DrainReport | undefined>();
};
