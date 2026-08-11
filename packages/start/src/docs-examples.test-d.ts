// Every code sample the root `README.md` and `packages/start/README.md` ship,
// compiled. A sample that stops compiling fails `pnpm typecheck`.
//
// The one deliberate divergence from the published text: the samples import
// from `./index.js` / `./testing.js` where a reader imports `@btravstack/start`
// and `@btravstack/start/testing`. The package cannot resolve its own name from
// inside its own source tree, and those two specifiers are exactly what
// `package.json`'s `exports` map points at.

import { Module, Port, Provider, type AnyPort, type Context } from "@btravstack/di";
import { Ok, OkAsync, P, type AsyncResult } from "unthrown";
import { expectTypeOf } from "vitest";

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
// timer, so the sample stays self-contained — `@btravstack/start-http` and its
// siblings are not written yet.
const ticker: Runtime<typeof Greeter> = {
  name: "ticker",
  needs: [Greeter],
  start: (host) => {
    const timer = setInterval(() => {
      // Every piece of work goes through `host.run`: that is what makes it
      // count towards the drain, and what gives it an `AbortSignal`.
      void host.run({ kind: "tick", id: `${Date.now()}` }, (ctx, signal) =>
        signal.aborted ? Ok("") : Ok(ctx.get(Greeter).greet("world")),
      );
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

await runMain(start(AppModule, { runtime: ticker }));

// ---------------------------------------------------------------------------
// "The Runtime contract" — root README. Asserted equal to the shipped types
// rather than merely compiled, so the README cannot drift from `runtime.ts`.
// ---------------------------------------------------------------------------

type ReadmeServing = {
  readonly drain: (signal: AbortSignal) => AsyncResult<void, never>;
  readonly stop: () => AsyncResult<void, never>;
};

type ReadmeRuntime<Needs extends AnyPort> = {
  readonly name: string;
  readonly needs: readonly Needs[];
  readonly start: (host: RuntimeHost<Needs>) => AsyncResult<Serving, RuntimeStartFailed>;
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
// "The unit of work" — root README.
// ---------------------------------------------------------------------------

const submitOne = (run: RunUnit<typeof Greeter>, meta: UnitMeta): AsyncResult<string, never> =>
  run(meta, (ctx, signal) => (signal.aborted ? Ok("") : Ok(ctx.get(Greeter).greet("world"))));

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
    await unit.result;

    return await app.exited;
  });

  // `{ inFlightAtStart: 1, completed: 1, abandoned: 0 }` at runtime; the drain
  // slot is optional in the type because a non-signal exit skips the drain.
  expectTypeOf(report.getOrThrow().drain).toEqualTypeOf<DrainReport | undefined>();
};
