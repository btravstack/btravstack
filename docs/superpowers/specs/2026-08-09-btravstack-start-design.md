# `@btravstack/start` — the application kernel — Design

**Date:** 2026-08-09
**Status:** Approved, pending implementation plan
**Depends on:** [`@btravstack/di`](https://github.com/btravstack/di), `unthrown`
**First client:** `saas-starter`

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
application is booted *by*, so drafting it inside one would bake that application's
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

| | NestJS | `di` + `start` |
|---|---|---|
| Wiring declared by | decorators + metadata reflection | explicit `Module`/`Provider` values |
| Missing dependency | boot-time exception | compile error |
| Module privacy | enforced at runtime | compile error |
| Cycles | `forwardRef()` | detected pre-construction, as a defect |
| Request scope | request-scoped providers bubble up the injection chain | `forkScope` — parent services seeded, not reconstructed |
| Lifecycle hooks | 5 interfaces + `enableShutdownHooks()` | `onStart`/`onStop` per provider; `start` owns signals |
| Failures | thrown | `Result` |

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
  readonly start: (host: RuntimeHost<Needs>) => AsyncResult<Serving, RuntimeStartFailed>;
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

A runtime receives a **host**, not a bare `Context`: it needs both the application
services and the kernel's `run` (below), and handing it a `Context` alone would leave it
inventing its own unit tracking — the thing the kernel exists to own.

A runtime declares the ports it needs, and `start` checks them against the module's
exports **at compile time**. Booting an HTTP runtime that requires a `Router` against a
module that does not export one is a type error at the `start` call, in the same style as
`di`'s "UNSATISFIED DEPENDENCIES" gate — not a boot-time crash.

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

### Probes

Liveness and readiness are process-level concerns, not transport-level ones, so the kernel
runs its own `node:http` probe server on a separate port (default 9000, disableable):
liveness from the state machine, readiness true only in `serving`. This is how a Temporal
worker pod with no HTTP runtime still gets probes, and why the HTTP runtime never has to
expose `/healthz` on the public port.

## The unit of work

Every runtime does the same thing in a loop: take one piece of work, run it, produce an
outcome. The kernel names that a **unit** and owns it, so three runtimes do not each
invent it.

```ts
const outcome = await run({ kind: "message", id: delivery.messageId }, (ctx, signal) =>
  handle(delivery, ctx.get(Transaction), signal),
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
  work: (ctx: Context<Needs | UnitPorts>, signal: AbortSignal) => AsyncResult<T, E>,
) => AsyncResult<T, E>;

type UnitMeta = { readonly kind: string; readonly id: string };
```

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

The line holds because what `di` exists to prevent is hidden *dependencies*: code that
secretly needs a collaborator it never declared and cannot be tested without it. A trace
id is not a collaborator — there is no substitutability question, no test double, nothing
to swap. A repository pulled from an ambient store is the untestable coupling; a tenant id
read by the Postgres adapter is not.

Legitimate readers are infrastructure adapters only — logger, OTel exporter, database
adapter. Application code reading the store is a lint error, enforced by a rule in
`@btravstack/oxlint`, in the same spirit as `unthrown/no-catch-all-pattern` stating
`unthrown`'s own default.

## Failure model

Failures are classified by **phase**, and each phase has one honest channel.

**Startup — modeled `Err`.** `StartupFailure` is a `TaggedError` union:

```ts
type StartupFailure =
  | ConstructionFailed   // a provider returned Err: bad config, database refused the connection
  | RuntimeStartFailed;  // port in use, broker unreachable, task queue rejected
```

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
completing it *wrongly*, and half-finished correct work beats confidently-wrong finished
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

The default sink writes JSON to stderr. The later observability package binds to these
events rather than the kernel reaching up for a logger, which keeps the dependency arrow
pointing the right way.

## `runMain` and exit codes

```ts
type ExitReport = {
  readonly reason: "signal" | "runtimeStopped" | "uncaught";
  readonly drain: DrainReport | undefined; // absent when the drain was skipped
  readonly teardownErrors: readonly { readonly port: string; readonly cause: unknown }[];
  readonly uptimeMs: number;
};
```

`start` returns `AsyncResult<ExitReport, StartupFailure>`. It never throws and never calls
`process.exit` — that keeps it embeddable in tests and in a development runner booting two
applications side by side.

`runMain(start(…))` is the single sanctioned place the process dies:

| Code | Meaning |
|---|---|
| `0` | clean exit |
| `1` | startup failure (modeled) |
| `2` | drained with abandoned work |
| `70` | defect (sysexits `EX_SOFTWARE`) |

## Testing

**There is no `overrideProvider`.** Nest needs
`Test.createTestingModule().overrideProvider(X).useValue(fake)` because its wiring is
runtime metadata. Here, swapping an adapter is composing a different module — which `di`
already documents and the type checker already verifies. A test application is an
application; the kernel adds nothing to that story.

What the kernel must add is deterministic control of the lifecycle:

```ts
await withApp(TestAppModule, { runtime: testRuntime(), clock: fakeClock }, async (app) => {
  const unit = app.runtime.submit(work);
  const drained = app.drain();
  expect(app.ready).toBe(false);
  await fakeClock.advance(seconds(5));
  unit.settle();
  expect(await drained).toBeOkWith({ abandoned: 0 });
});
```

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

| Not here | Where |
|---|---|
| Routing, middleware, `Result` → HTTP status | `@btravstack/start-http` |
| Consumer runtime | `@btravstack/start-amqp` (over `amqp-contract`) |
| Worker runtime | `@btravstack/start-temporal` (over `temporal-contract`) |
| Logger, OpenTelemetry | observability package, binding to `KernelEvent` |
| Configuration loading | harvested from `@saas/platform-config` |
| Authentication, authorisation | separate, later |
| CLI, scaffolding | separate, later |

**Dependencies: `unthrown`, `@btravstack/di`, and `node:` builtins. Nothing else** — the
same discipline as core `unthrown`'s zero-dependency rule.

## Open questions

- Whether `unit` should accept a module **factory** (`(meta) => Module`) so per-unit values
  such as a request id can be provided as ports, or whether those belong in the ambient
  record only. The `di` request-scope how-to shows the factory form working; the cost is a
  module allocation per unit.
- Whether `Deadline` is a plain timestamp or a port, given the injectable `Clock`.
- Whether the probe server should also expose a startup probe distinct from liveness, for
  slow-building graphs.
