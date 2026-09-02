---
title: Coming from NestJS
description: Six differences that actually change how you write code, each with the source it was checked against — and what NestJS does better.
---

# Coming from NestJS

> **Explanation.** This page is about _understanding_ — what changes when you
> move from NestJS to btravstack, and what does not. It is not a migration
> guide. For the design behind the differences, start with
> [Why btravstack?](/explanation/why-btravstack); for the surface, see
> [`start` and `StartOptions`](/reference/core/start).

NestJS and btravstack solve overlapping problems and disagree about roughly six
things. Every row below was checked before it was written: our side against a
file in this repository, Nest's side against Nest's own documentation, both
named in the prose under the table. **A row we could not check on both sides is
not on this page.**

Two rows are narrower than a comparison page usually makes them, deliberately.
Nest validates configuration at bootstrap and Nest overrides providers into the
real module — the popular versions of those two claims are wrong, and the real
differences are stated instead.

|                       | NestJS                                                                     | btravstack                                                                           |
| --------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Wiring is checked     | at startup, when the container instantiates providers                      | at compile time, at the `Module.scoped` call, with the missing ports named           |
| Declaring a provider  | `@Injectable()` / `@Module()` decorators; resolution by token              | plain values — a port is a class, a provider is a value, dependencies named by key   |
| Failures              | thrown, and caught by a built-in exceptions layer                          | an `unthrown` `Result`, on every async surface but three                             |
| Shutdown              | five lifecycle hooks; the three shutdown ones need `enableShutdownHooks()` | a three-beat drain, with a delay sized for Kubernetes endpoint propagation           |
| Configuration         | validated at bootstrap _if_ you pass a schema; read later by key           | the validated object **is** the injected value; failure is a modeled `ConfigInvalid` |
| Overriding for a test | `overrideProvider(token).useValue(…)`, applied at `compile()`              | the same idea; the double is typed against the port, and fixture drift fails loudly  |

## Wiring is checked

Nest resolves dependencies when the container builds them. Its own FAQ documents
the failure as a startup error — _"Nest can't resolve dependencies of the
`<provider>` (?). Please make sure that the argument `<unknown_token>` at index
`[<index>]` is available in the `<module>` context"_ — and lists the causes,
the most common being a provider left out of a module's `providers` array
([Common errors](https://docs.nestjs.com/faq/common-errors)).

Here that is a compile error. `Module.scoped` carries a `DependencyGate` marker
on its `module` parameter, so a composition whose ports nothing provides fails
to assign, and the diagnostic ends on the missing ports:
`'{ readonly "UNSATISFIED DEPENDENCIES — nothing provides": Logger | OrderRepository; }'`.
That exact message is pinned by a type test that is part of the gate —
`examples/order-application/src/needs-gate.test-d.ts`, one of four such files
spread across four example workspaces. Between them they pin four mechanisms,
which are easy to conflate: this one, di's `DependencyGate` on `Module.scoped`;
di's `NeedsGate`, for a module whose own provider reads a port it never
declared; `start`'s `NO RUNTIME` arm, for a root that exports no runtime port;
and plain assignability on `start`'s `module` parameter, for a composition that
imports a starter without providing its router, activities or handlers — that
last one is not a gate arm at all, just a `Needs` the parameter will not take.
The container's surface is [Modules](/reference/di/modules) and
[Ports](/reference/di/ports), and the reasoning is on
[Compile errors, not surprises](/explanation/compile-time-wiring).

The cost is real and worth naming: there is no auto-discovery. A provider writes
out the ports it depends on, and that record is what buys the checking.

## Declaring a provider

Nest's docs describe `@Injectable()` as a decorator that _"attaches metadata to
the class, signaling that `CatsService` is a class that can be managed by the
Nest IoC container"_, and resolution as a token lookup: _"When it finds the
`CatsService` dependency, it performs a lookup on the `CatsService` token"_
([Providers](https://docs.nestjs.com/providers),
[Custom providers](https://docs.nestjs.com/fundamentals/custom-providers)). A
token need not be a class — _"Sometimes, we may want the flexibility to use
strings or symbols as the DI token"_ — and then injection needs an explicit
`@Inject('CONNECTION')`. That metadata has to be emitted by the build: the
`.swcrc` in Nest's own [SWC recipe](https://docs.nestjs.com/recipes/swc) sets
`"legacyDecorator": true` and `"decoratorMetadata": true`, and the page names
both as properties a project must add.

btravstack has no decorators. A port is a class
(`class OrderRepository extends Port("OrderRepository")<Shape> {}` —
[Ports](/reference/di/ports)), a provider is a value, and its dependencies are named
by key in a record. No tsconfig in this repository sets `experimentalDecorators`
or `emitDecoratorMetadata`, and no published package depends on
`reflect-metadata` — checkable in one grep over `packages/*/package.json`.
`@btravstack/di` has no runtime dependencies at all; `unthrown` is a peer.

## Failures

Nest's exceptions layer is _"responsible for processing all unhandled exceptions
across an application"_, and filters _"let you control the exact flow of control
and the content of the response sent back to the client"_
([Exception filters](https://docs.nestjs.com/exception-filters)). The idiom is
`throw new HttpException(...)` from a service, and a `@Catch()` filter mapping
it.

Here nothing throws to a caller: every fallible surface returns an `unthrown`
`Result`, and every async surface an `AsyncResult` — including the ones that
cannot fail, where `AsyncResult<T, never>` is this project's spelling of "async,
and cannot fail". See [Nothing throws](/explanation/nothing-throws).

There are exactly **three** documented exceptions, and a reader who goes looking
will find them, so they are here too: `runMain` returns `Promise<void>` because
its job is to leave the `Result` world and become an exit code; `UnitWork`'s
`Promise<Result<T, E>>` arm exists to accept a caller's own `async` handler; and
`@btravstack/testing`'s `bootFixture` follows vitest's
`(ctx, use) => Promise<void>` fixture protocol, which the harness does not get
to choose. Each carries a reason where it lives, and the rule they are exceptions to is
[Nothing throws](/explanation/nothing-throws).

The other half of this is that mapping an outcome to a transport is not the
kernel's business either — `Result` → HTTP status belongs to the router, and
that is a separate decision:
[The kernel maps nothing](/explanation/the-kernel-maps-nothing).

## Shutdown

Nest has five lifecycle hooks, in order: `onModuleInit`,
`onApplicationBootstrap`, `onModuleDestroy`, `beforeApplicationShutdown`,
`onApplicationShutdown`. The shutdown half is opt-in — _"Shutdown hook listeners
consume system resources, so they are disabled by default"_, and _"to use
shutdown hooks, you must enable listeners by calling `enableShutdownHooks()`"_.
Nest will wait on a hook that returns a promise
([Lifecycle events](https://docs.nestjs.com/fundamentals/lifecycle-events)).

Those hooks and a scope closing are the same idea, and btravstack's scope
finalisers do that work on every exit path. The difference is what happens
_before_ them. On a signal the kernel runs three beats: readiness flips false
and the unit counts are sampled, synchronously; then it waits `preDrainDelayMs`
(default `5_000`) **before** telling the runtime to stop accepting; then
in-flight work gets `drainTimeoutMs` (default `20_000`), and whatever is still
open at the deadline is aborted and reported `abandoned`. Both defaults are in
`packages/core/src/start.ts`, and the sequence is
[Draining, in three beats](/explanation/draining-in-three-beats).

Beat 2 is the one that is easy to read as a pointless sleep. Kubernetes endpoint
removal is eventually consistent, so a pod that stops accepting the instant
SIGTERM lands rejects traffic the ingress is still routing to it. `20_000` sits
deliberately under the Kubernetes `terminationGracePeriodSeconds` default of
30 s, leaving headroom before SIGKILL — raise one and you must raise the other.

Nest's lifecycle documentation describes no equivalent delay; what it describes
is when each hook runs. It does mention Kubernetes once — _"This feature is
often used with Kubernetes to manage containers' lifecycles"_ — but that
sentence is about **when the hooks are invoked**, on the container's lifecycle
signals. It is not a delay, and endpoint propagation is the specific thing beat
2 exists for.

## Configuration

The unfair version of this row says Nest does not validate. It does. Nest's
`ConfigModule.forRoot()` takes a `validationSchema` (Joi), and validation runs
before the app bootstraps; a custom `validate` function is also supported, and
_"if the function throws an error, it will prevent the application from
bootstrapping"_
([Configuration](https://docs.nestjs.com/techniques/configuration)).

The honest difference is not _whether_ but _where_, and it has two halves.

**The read is a key lookup, separate from the schema.** `ConfigService` provides
_"a `get()` method for reading these parsed/merged configuration variables"_,
called as `get<string>('DATABASE_USER')` — the caller supplies the generic and
the string key, and without a default `get()` returns `undefined` for a key
nobody set. Nest offers `registerAs()` and `ConfigType<typeof databaseConfig>`
to tie the two ends back together, which is exactly the seam this describes.
Here there is no lookup at all: `Config.provider(port)(schema)` reads the `Env`
port, validates once as the graph is built, and the **validated object is the
service on the port**. A field that is not in the schema is not a key that
returns `undefined`; it is a property that does not exist
([`@btravstack/config`](/reference/config)).

**The failure is a value, not a throw.** `Config.object`'s `validate` never
throws, walks every field so an operator gets one round trip rather than one
variable per restart, and reports `ConfigInvalid` with every offending variable
named. `runMain` turns that into `startFailed` on stderr and exit code `78`
(`EX_CONFIG`, `packages/core/src/run-main.ts`). No `main.ts` folds issues into a
message and an exit code by hand. The semantics fixed once, and pinned by
`config.spec.ts`: an empty or blank value is a configuration **error**, not an
absent one, because `Number("")` is `0` and `PORT=` would otherwise bind the
ephemeral port. See [`@btravstack/config`](/reference/config).

## Overriding for a test

The unfair version of this row says Nest builds a parallel graph. It does not
have to. Nest's testing docs show `imports: [CatsModule]` with
`.overrideProvider(CatsService).useValue(mockCatsService)` — a real application
module, with one provider substituted inside it — and the override methods
`useClass` / `useValue` / `useFactory` _"mirror those described for custom
providers"_ ([Testing](https://docs.nestjs.com/fundamentals/testing)). Nest also
has `overrideModule().useModule()` for the coarser swap. `compile()` is
asynchronous and awaited, and that is when the module is built.

`overridden(module, [providers])` is the same idea, and this project reached it
by the same route Nest did: the alternative it replaced was four hand-maintained
parallel roots in `examples/` that mirrored the real ones and drifted silently.
So the row is not "parallel graph versus real root". Two narrower things differ,
both on our side and both checkable in
`packages/testing/src/overridden.ts`:

- **The double is typed against the port.** Each override is an ordinary
  `Provider(Port)(...)`, so the substituted service's type is checked against the
  port at that call, before anything is built.
- **An override the root no longer backs fails loudly.** The base provider is
  never constructed, and an override for a port the tree no longer provides is a
  [`WiringDefect`](/reference/di/wiring-defects) — "nothing to override" — which
  is what turns fixture drift into a failure rather than a mock nobody uses.

And one deliberate limit, stated so it is not discovered later: `overridden`
replaces one **provider**, never a subsystem. The replaced provider's siblings
still construct, so swapping a whole adapter stack — or a graph whose shape
varies per test — is still a different module composed in its place. See
[`@btravstack/testing`](/reference/testing).

## What NestJS does better

A comparison page that admits nothing is not read as one, and these are not
consolation prizes — for a lot of teams they decide the question.

**The ecosystem is not close.** Nest has first-party packages for most things a
backend needs: GraphQL, WebSockets, microservice transports, scheduling, queues,
caching, health checks, Swagger generation, an ORM integration story for several
ORMs. btravstack has thirteen packages and three transports, and a workload the
[transport role map](/explanation/one-process-one-runtime) does not cover is a
decision somebody has to make rather than a package they install.

**Integrations are maintained by people who are not you.** When a Nest
integration breaks, it is usually somebody's job to fix it. Here the surface
around the framework is your own composition, and a starter that does not exist
is code you write.

**There is an enterprise story.** Nest has commercial support, training, a
consulting network, and a hiring pool measured in years of job postings.
btravstack has none of that, and pre-1.0 it still makes breaking changes
deliberately — `Port.many` and `withApp` were removed in a single afternoon.

**Decorators are genuinely more concise.** `@Injectable()` and a constructor
parameter is less to write than a port, a provider and a named dependency
record. What that concision costs is the checking in the first row; if that
trade does not look worth it for your system, Nest is the better tool and this
page has done its job.

## Where to go next

- The first thesis, and the one the rest hang off:
  [One process, one runtime](/explanation/one-process-one-runtime).
- The gate the first row is about:
  [Compile errors, not surprises](/explanation/compile-time-wiring).
- Get your hands on it: [Getting started](/tutorial/getting-started).
