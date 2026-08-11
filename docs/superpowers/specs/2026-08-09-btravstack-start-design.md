# `@btravstack/start` — the application kernel — Design

**Date:** 2026-08-09
**Status:** **Implemented** (2026-08-10). This document is the design as approved;
it is kept as the historical record and is **not** the current reference.
**Depends on:** [`@btravstack/di`](https://github.com/btravstack/di), `unthrown`
**First client:** `saas-starter`

> **Read this first.** The package shipped, and the design moved in specific
> places while it was being built. This document has **not** been rewritten to
> hide that: the original text stands, with a `> **Shipped as:**` callout wherever
> it is now wrong, and every delta collected in
> [Changes during implementation](#changes-during-implementation) at the end.
>
> The **current** reference is [`CLAUDE.md`](../../../CLAUDE.md) at the repository
> root, plus the two READMEs. When this document and `CLAUDE.md` disagree,
> `CLAUDE.md` is right.

## Purpose

The btravstack libraries cover the domain layer of a backend application — errors as
values (`unthrown`), compile-time wiring (`@btravstack/di`), domain entities
(`@btravstack/entity`), typed transports (`amqp-contract`, `temporal-contract`,
`@unthrown/orpc`). What is missing is the runtime layer: the thing that turns a
declared graph into a running process, and stops it again without losing work.

`@btravstack/start` is that piece, and only that piece. It owns three things — the
application object, the lifecycle state machine, and the `Runtime` contract — and it
knows nothing about HTTP, AMQP or Temporal.

Unlike `@btravstack/entity` and `@btravstack/di` — both drafted inside `saas-starter` as
`@saas/platform-*` and extracted once proven — this package is built in its own repository
from the start, with `saas-starter` as its first consumer rather than its host. The kernel
has no useful shape as an application-internal module: it exists to be the thing an
application is booted _by_, so drafting it inside one would bake that application's
assumptions into the contract it is supposed to define.

## What it is not

NestJS's `NestFactory.create(AppModule)` **is** the wiring step: Nest reads decorator
metadata at runtime, resolves tokens, builds the injector graph, and throws at boot when
something is missing. The graph is discovered while the process starts.

`di` proves the graph before the process exists. `Module` / `Provider` / `Port`
declarations are the wiring, and the type checker verifies them; a missing dependency, a
private port leaking out of a module, or a re-export of something never imported are
compile errors. What cannot be proven statically — a cycle, two providers for one port —
is caught before any factory runs, as a defect.

So `start` does not wire. It owns **when** an already-proven graph is constructed and
torn down, and nothing more.

|                    | NestJS                                                 | `di` + `start`                                          |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------- |
| Wiring declared by | decorators + metadata reflection                       | explicit `Module`/`Provider` values                     |
| Missing dependency | boot-time exception                                    | compile error                                           |
| Module privacy     | enforced at runtime                                    | compile error                                           |
| Cycles             | `forwardRef()`                                         | detected pre-construction, as a defect                  |
| Request scope      | request-scoped providers bubble up the injection chain | `forkScope` — parent services seeded, not reconstructed |
| Lifecycle hooks    | 5 interfaces + `enableShutdownHooks()`                 | `onStart`/`onStop` per provider; `start` owns signals   |
| Failures           | thrown                                                 | `Result`                                                |

The accepted cost is that there is **no auto-discovery**. Nest lets a class be
`@Injectable()` and listed in `providers`; `di` requires the provider and its dependency
array to be written out. That array is what inference reads, and it is what buys the
compile-time checking.

## One process, one runtime

The kernel knows several kinds of runtime. A process boots exactly one.

```ts
await start(AppModule, { runtime: http({ port: 3000, router }) });
```

An `api` deployment, a `consumer` deployment and a `worker` deployment are three
processes booting the **same** `AppModule` with a different runtime. They scale, fail and
deploy independently, which is what Kubernetes wants anyway, and it removes an entire
class of design problem: there is never a question of how two runtimes in one process
share a drain deadline or which one's failure takes the process down.

## The `Runtime` contract

```ts
type Runtime<Needs extends AnyPort> = {
  readonly name: string;
  readonly needs: readonly Needs[];
  readonly start: (
    host: RuntimeHost<Needs>,
  ) => AsyncResult<Serving, RuntimeStartFailed>;
};

type RuntimeHost<Needs extends AnyPort> = {
  readonly ctx: Context<Needs>;
  readonly run: RunUnit<Needs>;
};

type Serving = {
  readonly drain: (deadline: Deadline) => AsyncResult<DrainReport, never>;
  readonly stop: () => AsyncResult<void, never>;
};
```

> **Shipped as:** two changes to this block.
>
> `RuntimeHost.ctx` is `Context<InstanceType<Needs>>`, not `Context<Needs>`. A
> runtime declares its needs as port **classes** (`AnyPort` is
> `abstract new () => AnyPortInstance`), while di parameterises `Context<in R>`
> by port **instance** types. `RunUnit` and `RuntimeHost` are both parameterised
> by the classes and hand out the instance-typed context.
> `InstanceType<never>` is `never`, so a needs-free runtime is unaffected.
>
> `Serving.drain` is `(signal: AbortSignal) => AsyncResult<void, never>` — it
> returns **nothing**, not a `DrainReport`. Only the kernel can see the unit
> registry, so the kernel owns the accounting; `drain` means "stop accepting",
> and the `AbortSignal` fires when the kernel's own deadline passes, so a runtime
> never does arithmetic on time.

A runtime receives a **host**, not a bare `Context`: it needs both the application
services and the kernel's `run` (below), and handing it a `Context` alone would leave it
inventing its own unit tracking — the thing the kernel exists to own.

A runtime declares the ports it needs, and `start` checks them against the module's
exports **at compile time**. Booting an HTTP runtime that requires a `Router` against a
module that does not export one is a type error at the `start` call, in the same style as
`di`'s "UNSATISFIED DEPENDENCIES" gate — not a boot-time crash.

> **Shipped as:** a **trailing phantom rest-tuple gate** on `start` (and on
> `withApp`) —
> `...gate: [InstanceType<Needs>] extends [X] ? [] : [error: "UNSATISFIED RUNTIME NEEDS", missing: …]`.
> A conditional type on an inference-bearing parameter (`module`, `options`) was
> rejected: it makes TypeScript defer that parameter's inference and can collapse
> `X` or `E` to `unknown`.
>
> It **is bypassable**, and that is stated rather than glossed: a caller who
> hand-writes the phantom arguments —
> `start(M, o, "UNSATISFIED RUNTIME NEEDS", new Clock())` — does typecheck. This
> is asserted in `start.test-d.ts`, not assumed. It is the same escape hatch di's
> own gate leaves: a deliberate act, and the gate exists to catch the accident,
> not to be unforgeable.

`start` is a thin wrapper over `Module.scoped`: build the container, hold the application
scope open for the process's life, hand the built `Context` to the runtime, close the
scope on the way out. Everything `di` guarantees — LIFO teardown, close on every path,
finaliser failures never masking the real error — is inherited, not reimplemented.

## Lifecycle

```
building ──▶ starting ──▶ serving ──▶ draining ──▶ stopping ──▶ exited
   │            │            │                        ▲
   └────────────┴────────────┴────────────────────────┘
              (any failure short-circuits to stopping)
```

`building` and `starting` belong to `di` — provider construction by level, then `onStart`
hooks. `serving` belongs to the runtime. `draining`, `stopping` and `exited` belong to the
kernel, and they are separate states because **stopping is not draining**.

### Draining, in three beats

1. Readiness flips `false`.
2. The kernel waits `preDrainDelay` (default 5s) before telling the runtime to stop
   accepting.
3. In-flight work gets until `drainTimeout` (default 20s) to finish; the unit
   `AbortSignal` fires at that deadline.

Beat 2 looks like a pointless sleep and is not. Kubernetes endpoint removal is eventually
consistent, so a pod that stops accepting the instant SIGTERM lands rejects requests the
ingress is still routing to it. It is the most common production bug in Node-on-k8s
deployments, and shipping the fix as a default is worth more than most of the framework.

`drainTimeout` sits deliberately under the k8s `terminationGracePeriodSeconds` default of
30, leaving headroom for `stopping` before SIGKILL. That relationship is documented as a
rule, not a footnote.

A **second signal skips the drain** and goes straight to `stopping` — double Ctrl-C in
development, and an operator's escape hatch in production.

Signals are the kernel's exclusive property. No other library in the stack subscribes to
`SIGTERM`/`SIGINT`; `start` subscribes and removes its listeners on exit, so a test
harness can boot many applications in one process.

Draining produces a value, not a log line: `DrainReport { inFlightAtStart, completed,
abandoned }`. Tests assert on it; operators see `abandoned: 3` rather than silence.

> **Shipped as:** the three fields have precise, non-obvious meanings.
>
> - `inFlightAtStart` — units in flight when the drain began, sampled
>   synchronously in beat 1 (not after the pre-drain delay, so it stays honest
>   against a unit that starts or closes during the delay).
> - `completed` — units that **closed during** the drain, counted as a delta of a
>   **monotonic** total (`closed() - closedAtStart`). It may therefore **exceed**
>   `inFlightAtStart` when in-flight work spawned more units during the drain.
>   That is honest reporting, not a bug: the obvious `inFlightAtStart - abandoned`
>   goes **negative** the moment a unit starts after the sample and closes before
>   the deadline.
> - `abandoned` — units still open at the deadline, aborted there. **This is the
>   field the exit code keys on.**

### Probes

Liveness and readiness are process-level concerns, not transport-level ones, so the kernel
runs its own `node:http` probe server on a separate port (default 9000, disableable):
liveness from the state machine, readiness true only in `serving`. This is how a Temporal
worker pod with no HTTP runtime still gets probes, and why the HTTP runtime never has to
expose `/healthz` on the public port.

> **Shipped as:** `GET /livez` → 200 `ok` / 503 `unavailable`, `GET /readyz` →
> 200 `ready` / 503, anything else 404. Readiness is `serving` **and not forced
> unready** — a one-way latch flipped by the drain and by an uncaught exception,
> never reset. The server binds **`127.0.0.1` only** and is `unref`'d, so it never
> keeps the event loop alive. `probes: { port: 0 }` lets the OS choose and
> `app.probePort()` reads it back. A bind failure is a startup failure: it stops
> the graph being built at all.
>
> `app.ready()` is also exposed on `RunningApp` as a **synchronous** read of the
> same predicate — the uncaught path forces readiness false while the phase is
> still `"serving"`, a single-tick window no HTTP round trip can observe.

## The unit of work

Every runtime does the same thing in a loop: take one piece of work, run it, produce an
outcome. The kernel names that a **unit** and owns it, so three runtimes do not each
invent it.

```ts
const outcome = await run(
  { kind: "message", id: delivery.messageId },
  (ctx, signal) => handle(delivery, ctx.get(Transaction), signal),
);
```

`run` — reached through the `RuntimeHost` — forks the application scope with
`Module.forkScope` over an optional per-unit module passed to `start` as `unit`: a fresh
transaction per unit, released when the unit settles, the pool untouched. The forked
`Context` carries both channels, the parent's exports and the unit module's, exactly as
`di`'s request-scope how-to describes.

```ts
type RunUnit<Needs extends AnyPort> = <T, E>(
  meta: UnitMeta,
  work: (
    ctx: Context<Needs | UnitPorts>,
    signal: AbortSignal,
  ) => AsyncResult<T, E>,
) => AsyncResult<T, E>;

type UnitMeta = { readonly kind: string; readonly id: string };
```

> **Shipped as:** the forking is **deferred** — see the first open question
> below. `run` hands the work the _application_ `Context`
> (`Context<InstanceType<Needs>>`, per change #4), there is no `unit` option on
> `StartOptions`, and `UnitPorts` does not exist. `RunUnit` is typed so the
> `Module.forkScope` call lands in one place when a runtime needs it.
>
> `UnitMeta` grew three optional fields that feed the ambient record:
> `{ kind, id, traceId?, tenantId?, deadline? }`, with `traceId` defaulting to
> `id`. `UnitWork` also accepts a `Promise<Result>` or a plain `Result`, not only
> an `AsyncResult`, so an ordinary `async` handler compiles without lifting.

`run` is transparent to the work's own channels: whatever `Result` the handler produces is
what the runtime receives back. The kernel observes only that the unit settled.

**In-flight tracking falls out of this.** The kernel counts open units, so `drain` means
only "stop accepting" and the kernel itself waits for the count to reach zero. No runtime
implements its own counting, and `DrainReport.abandoned` is accurate without cooperation.

**The kernel never maps an outcome to a transport.** `Result` → HTTP status belongs to the
HTTP runtime, `Result` → ack/nack/DLQ to the AMQP runtime, `Result` → activity failure to
the Temporal runtime. The kernel hands back the `Result` and stays out of it.

## The context rule

> **Ambient carries data. `Context` carries capabilities.**

`di`'s scope is lexical: a `Context` arrives in a callback and is passed explicitly. That
is correct for wiring and insufficient for a small set of values that cannot realistically
be threaded — an OTel span every log line and query should attach to, a tenant id the
Postgres adapter needs as `SET LOCAL app.tenant_id` on whichever pooled connection the
query lands on, a correlation id inside a logger called five frames down.

The kernel therefore opens one `AsyncLocalStorage` store per unit holding a small, fixed,
serialisable record — `{ unitId, traceId, tenantId?, deadline }` — and nothing else.
Services never go in it.

The line holds because what `di` exists to prevent is hidden _dependencies_: code that
secretly needs a collaborator it never declared and cannot be tested without it. A trace
id is not a collaborator — there is no substitutability question, no test double, nothing
to swap. A repository pulled from an ambient store is the untestable coupling; a tenant id
read by the Postgres adapter is not.

Legitimate readers are infrastructure adapters only — logger, OTel exporter, database
adapter. Application code reading the store is a lint error, enforced by a rule in
`@btravstack/oxlint`, in the same spirit as `unthrown/no-catch-all-pattern` stating
`unthrown`'s own default.

> **Shipped as:** the record and `currentUnit()` shipped; **the lint rule did
> not.** It needs a way to identify an infrastructure adapter, which is a
> convention this stack has not established, so it is deferred. Today "a lint
> error" is the _intended end state_, not the current one — it is a documented
> convention with no enforcement, and should not be written up as enforced.

## Failure model

Failures are classified by **phase**, and each phase has one honest channel.

**Startup — modeled `Err`.** `StartupFailure` is a `TaggedError` union:

```ts
type StartupFailure =
  | ConstructionFailed // a provider returned Err: bad config, database refused the connection
  | RuntimeStartFailed; // port in use, broker unreachable, task queue rejected
```

> **Shipped as:** there is **no `ConstructionFailed` and no `StartupFailure`
> union.** Wrapping a construction failure in a kernel error erases the
> application's own modeled error type. `Module.scoped` already reports the
> module's `E`, so `start` returns
> `AsyncResult<ExitReport, E | RuntimeStartFailed>` and the application's
> construction errors pass through **unwrapped and still typed**.
> `RuntimeStartFailed` survives, because it is genuinely the kernel's own — and
> it covers one case the spec did not anticipate: a **probe-port bind failure**,
> minted as `RuntimeStartFailed({ runtime: "probes" })`.

Both carry the offending port or runtime name. These are operational and expected; a
container that cannot reach Postgres should not produce a stack trace.

**Wiring — `Defect`, untouched.** A cycle or duplicate provider arrives from `di` as a
defect and stays one. The kernel never launders it into `E`: a wiring bug is not something
a caller branches on.

**While serving — a phase transition.** A runtime losing its broker connection for good
moves the application to `draining` and records the cause in the exit report. It is not a
startup failure.

**Teardown — visible, never masking.** `di` guarantees a failing finaliser cannot
overwrite the real failure; the kernel supplies `onTeardownError` and collects them into
`ExitReport.teardownErrors` so they surface rather than vanish.

**Unit failures never reach the kernel.** A handler's `Err` is the runtime's to map.

**`uncaughtException` / `unhandledRejection` — liveness `false`, then straight to
`stopping`, skipping the drain.** Deliberately harsher than the signal path: after an
uncaught throw the process state may be corrupt, so draining in-flight work risks
completing it _wrongly_, and half-finished correct work beats confidently-wrong finished
work. These should be near-impossible in this stack — pipelines convert throws to defects
and `unthrown` adopts orphaned thenables — so one firing is real evidence of code running
outside a pipeline.

## Events, not a logger

The kernel emits structured events and takes no logger dependency:

```ts
type KernelEvent =
  | { type: "building" }
  | { type: "serving"; runtime: string }
  | { type: "draining"; inFlight: number }
  | { type: "drained"; report: DrainReport }
  | { type: "teardownError"; port: string; cause: unknown };
```

> **Shipped as:** eight events, not five — `stopping`, `exited` and
> `uncaught` (`{ cause: unknown }`) joined the list, so the event stream covers
> the whole state machine and names the cause of a crash. A **throwing sink is
> swallowed** (`safeSink`): a broken reporter must not take the process down
> mid-shutdown, since there is nowhere left to report it to.

The default sink writes JSON to stderr. The later observability package binds to these
events rather than the kernel reaching up for a logger, which keeps the dependency arrow
pointing the right way.

## `runMain` and exit codes

```ts
type ExitReport = {
  readonly reason: "signal" | "runtimeStopped" | "uncaught";
  readonly drain: DrainReport | undefined; // absent when the drain was skipped
  readonly teardownErrors: readonly {
    readonly port: string;
    readonly cause: unknown;
  }[];
  readonly uptimeMs: number;
};
```

`start` returns `AsyncResult<ExitReport, StartupFailure>`. It never throws and never calls
`process.exit` — that keeps it embeddable in tests and in a development runner booting two
applications side by side.

`runMain(start(…))` is the single sanctioned place the process dies:

| Code | Meaning                         |
| ---- | ------------------------------- |
| `0`  | clean exit                      |
| `1`  | startup failure (modeled)       |
| `2`  | drained with abandoned work     |
| `70` | defect (sysexits `EX_SOFTWARE`) |

> **Shipped as:** the table above is **missing a row**, and the omission was a
> real hole. `reason === "uncaught"` maps to **`70`** too, and it takes
> **precedence over** the abandoned-work `2`.
>
> | Code | Meaning                                                     |
> | ---- | ----------------------------------------------------------- |
> | `0`  | exited cleanly, or drained with nothing abandoned           |
> | `1`  | startup failure (a modeled `Err`)                           |
> | `2`  | drained with work abandoned                                 |
> | `70` | **stopped by an uncaught exception or unhandled rejection** |
> | `70` | a defect                                                    |
>
> Both `70`s are the same statement — sysexits(3)'s `EX_SOFTWARE`, an internal
> software error — reached through the two channels a bug can take. The
> precedence is not cosmetic: installing an `uncaughtException` or
> `unhandledRejection` handler **suppresses Node's own default exit code of 1**,
> so without this row a crashed process would report **success** to its
> orchestrator. In practice the uncaught path skips the drain, so `drain` is
> `undefined` and the two cases cannot collide — but the ordering is written out
> in `run-main.ts` rather than left to depend on that.
>
> The same suppression is a **footgun for an embedder who uses `start` without
> `runMain`**: nothing else sets an exit code, so a crash exits `0` silently.
> Documented in both READMEs.

## Testing

**There is no `overrideProvider`.** Nest needs
`Test.createTestingModule().overrideProvider(X).useValue(fake)` because its wiring is
runtime metadata. Here, swapping an adapter is composing a different module — which `di`
already documents and the type checker already verifies. A test application is an
application; the kernel adds nothing to that story.

What the kernel must add is deterministic control of the lifecycle:

```ts
await withApp(
  TestAppModule,
  { runtime: testRuntime(), clock: fakeClock },
  async (app) => {
    const unit = app.runtime.submit(work);
    const drained = app.drain();
    expect(app.ready).toBe(false);
    await fakeClock.advance(seconds(5));
    unit.settle();
    expect(await drained).toBeOkWith({ abandoned: 0 });
  },
);
```

> **Shipped as:** a sketch, not the API. The real shape is
> `withApp(module, { runtime, clock }, use)` where the **runtime object itself**
> is the handle (`runtime.untilStarted()`, `runtime.submit<T>()`), the app
> exposes `app.requestDrain()` / `app.stop()` / `app.ready()` (a **method**, not
> a property) / `app.phase()` / `app.probePort()`, and the drain report arrives
> on `await app.exited` as `ExitReport.drain` rather than from a `drain()` call.
> `withApp` **forces `signals` and `probes` off** whatever the caller passes.
> The compiling version is in both READMEs and in `docs-examples.test-d.ts`.

Three requirements follow, each a design constraint rather than a test convenience:

- **The clock is injectable.** `preDrainDelay` and `drainTimeout` read from a `Clock`, so
  drain tests are instant rather than twenty seconds long. A kernel whose own tests are
  slow gets tested badly.
- **`signals: false`.** Real signal handlers would fight across a Vitest file; the harness
  drives transitions directly.
- **`testRuntime()` ships from the kernel** — an in-memory `Runtime` letting the lifecycle
  be tested with no transport, and letting a test hold units open to prove drain
  behaviour.

### Load-bearing invariants

Following the house convention (`unthrown`'s `invariants.spec.ts`, guarded 1:1), each of
these gets an explicit test:

1. Readiness is `false` before the runtime stops accepting.
2. In-flight units complete when the drain has time for them.
3. Units still open at the deadline are counted in `DrainReport.abandoned`.
4. The unit `AbortSignal` fires at the drain deadline.
5. The application scope closes on every path — startup failure, clean stop, uncaught
   exception.
6. A second signal skips the drain.
7. Teardown errors are collected and never mask the exit reason.
8. `start` never throws and never calls `process.exit`.
9. Signal listeners are removed on exit, so a second `start` in the same process is clean.

## Non-goals

These are later packages, not later versions of this one.

| Not here                                    | Where                                                   |
| ------------------------------------------- | ------------------------------------------------------- |
| Routing, middleware, `Result` → HTTP status | `@btravstack/start-http`                                |
| Consumer runtime                            | `@btravstack/start-amqp` (over `amqp-contract`)         |
| Worker runtime                              | `@btravstack/start-temporal` (over `temporal-contract`) |
| Logger, OpenTelemetry                       | observability package, binding to `KernelEvent`         |
| Configuration loading                       | harvested from `@saas/platform-config`                  |
| Authentication, authorisation               | separate, later                                         |
| CLI, scaffolding                            | separate, later                                         |

**Dependencies: `unthrown`, `@btravstack/di`, and `node:` builtins. Nothing else** — the
same discipline as core `unthrown`'s zero-dependency rule.

## Open questions — all three now answered

- ~~Whether `unit` should accept a module **factory**~~ — **`unit` stays a
  module, and per-unit forking is deferred entirely.** No runtime needs a
  per-unit transaction yet, so `run` currently hands the work the _application_
  `Context`; `RunUnit` is typed for the fork, so the `Module.forkScope` call
  lands in one place with no signature change when the first runtime asks for
  it. The factory-vs-module question is deferred with it, not settled.
- ~~Whether `Deadline` is a plain timestamp or a port~~ — **neither: it is an
  `AbortSignal`, handed to `Serving.drain(signal)`.** The kernel already owns the
  clock and fires the signal when its deadline passes, so a runtime never does
  arithmetic on time and there is no `Deadline` type at all. (The unit-level
  `UnitMeta.deadline` is a separate thing: an optional `number` carried in the
  ambient record for adapters that want it.)
- ~~Whether the probe server should also expose a startup probe~~ — **no
  startup probe.** `/livez` answers from `building` onward, because the probe
  server binds _before_ `Module.scoped` runs, so a slow-building graph is
  already covered by `/readyz` alone. A fourth endpoint would have added a state
  with no distinct answer.

## Changes during implementation

Everything above is the design as approved on 2026-08-09. This is the list of
places the shipped package differs from it, with the reasoning. Each is also
marked inline, at the paragraph it affects.

| #   | Spec said                                                                   | Shipped                                                                                                          | Why                                                                                                                                                 |
| --- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `StartupFailure = ConstructionFailed \| RuntimeStartFailed`                 | `AsyncResult<ExitReport, E \| RuntimeStartFailed>` — the module's own `E`, unwrapped                             | Wrapping erases the application's modeled error type. `Module.scoped` already reports `E`.                                                          |
| 2   | `Clock` injectable, mechanism unstated                                      | `Clock.sleep(ms, signal?)`                                                                                       | A second signal has to cut the pre-drain delay short; an abortable sleep is the mechanism.                                                          |
| 3   | `Serving.drain(deadline) => AsyncResult<DrainReport, never>`                | `Serving.drain(signal: AbortSignal) => AsyncResult<void, never>`                                                 | Only the kernel can see the unit registry, so the kernel owns the accounting.                                                                       |
| 4   | `RuntimeHost.ctx: Context<Needs>`                                           | `Context<InstanceType<Needs>>`                                                                                   | A runtime declares needs as port **classes**; di's `Context<in R>` takes port **instance** types.                                                   |
| 5   | "checked at compile time, in the style of di's gate"                        | a trailing **phantom rest-tuple** gate, and it is **bypassable** by hand-writing the phantom arguments           | A conditional on an inference-bearing parameter defers inference and collapses `X`/`E` to `unknown`. The bypass is the same escape hatch di leaves. |
| 6   | exit codes `0` / `1` / `2` / `70` (defect)                                  | plus **`70` for `reason === "uncaught"`**, outranking `2`                                                        | Installing an uncaught handler suppresses Node's default exit `1`; without this row a crash reports success.                                        |
| 7   | `DrainReport { inFlightAtStart, completed, abandoned }`, meanings unstated  | `completed` is a **monotonic delta** and may exceed `inFlightAtStart`; `abandoned` is what the exit code keys on | The obvious `inFlightAtStart - abandoned` goes negative when a unit starts after the sample and closes before the deadline.                         |
| 8   | five `KernelEvent`s                                                         | eight (`stopping`, `exited`, `uncaught`), and a throwing sink is swallowed                                       | The stream should cover the whole state machine; a broken reporter must not take the process down mid-shutdown.                                     |
| 9   | probes "readiness true only in `serving`"                                   | `serving` **and** a one-way `forcedUnready` latch, plus a synchronous `app.ready()`                              | The uncaught path forces readiness false while the phase is still `serving` — a window no HTTP round trip fits inside.                              |
| 10  | `withApp(...)` sketch with `app.runtime.submit`, `app.drain()`, `app.ready` | the runtime object is the handle; `app.requestDrain()`, `app.ready()`; the report arrives via `app.exited`       | The sketch predated the API; the shipped one is compiled by `docs-examples.test-d.ts`.                                                              |

Not a deviation, but worth recording: **`options.signals === false` disables the
uncaught handlers as well as the signal handlers.** One flag, two process-global
handler families, because a test harness needs them all off together.
