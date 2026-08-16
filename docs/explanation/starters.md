---
title: Starters
description: The Spring Boot idea applied to this kernel — a module that brings one transport's default behaviour, opinionated about the one way it is done and configurable where a deployment differs.
---

# Starters

> **Explanation.** This page explains what a starter is here, why the three
> shipped ones are shaped alike, and what was folded in or removed to get
> there. For each starter's surface, see [`@btravstack/http`](/reference/http),
> [`@btravstack/temporal`](/reference/temporal) and
> [`@btravstack/amqp`](/reference/amqp); for the tasks, see [Serve an oRPC
> contract over HTTP](/how-to/serve-orpc-over-http), [Run a Temporal
> worker](/how-to/run-a-temporal-worker) and [Consume AMQP
> messages](/how-to/consume-amqp-messages).

The kernel knows nothing about HTTP, Temporal or AMQP, and it never will. What
it knows is a `Runtime` behind a port. A **starter** is a module that provides
that runtime for one transport, brings the default behaviour for the standard
case, is opinionated about the one way that transport is done here, and is
configurable where a deployment differs. The word is Spring Boot's, and so is
the idea: `spring-boot-starter-web` does not offer you a choice of servlet
containers on day one, it brings Tomcat and a sane configuration, and you
change what your deployment needs.

Three ship — `@btravstack/http`, `@btravstack/temporal`, `@btravstack/amqp` —
and they are deliberately the same shape.

## One way, and why

**oRPC is the one way HTTP is answered here.** `@btravstack/http` mounts an
oRPC router through `@orpc/server/node`'s `RPCHandler` and offers no other
router, no `handler` option, no listener port to provide yourself. That is not
a gap awaiting a plugin system. oRPC shares this stack's convictions — a
contract, typed errors, `Result` at the boundary through `@unthrown/orpc` — so
it is enforced rather than offered among alternatives. There was once a
separate `@btravstack/orpc` package sitting on a more general HTTP runtime; it
was folded into `@btravstack/http` for exactly that reason, and the general
runtime became an internal seam the package's own transport tests still drive.

The same rule holds for the other two. `@btravstack/temporal` is a
`temporal-contract` worker and calls `declareActivitiesHandler` itself;
`@btravstack/amqp` is an `amqp-contract` worker. Each is one library, chosen
because its convictions match, and neither is a facade over a choice.

Being opinionated is what lets a starter be small and lets an application be
almost entirely business code. It is also what makes "extensible" mean
something specific: you extend through ordinary di modules — a provider your
router declares, an import next to the starter — not through hooks in the
starter.

## Configurable where deployments differ

What differs between deployments is the environment, and a starter binds its
own slice of it. `http()` binds `PORT` and `HOST` onto `HttpConfig`,
`temporal()` binds `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE` onto
`TemporalConfig`, `amqp()` binds `AMQP_URL` onto `AmqpConfig` — each through
`Config.provider` reading the `Env` port the kernel provides, validated once as
the graph is built, and each a modeled `ConfigInvalid` naming its variables
when wrong. An application binds whatever else it needs onto ports of its own
the same way; nothing reaches for `process.env`.

Where an option is passed explicitly — `http({ port: 0 })` in a test — it is a
**pin**: `Config.pinned(value, field)` answers the value and reads nothing. The
precedence is explicit > environment > default, per field, and it is one
helper in `@btravstack/config` rather than a local copy in each starter.

## The module sugar

Each starter ships a composition-root sugar — `HttpModule(name)({ router,
imports, provides, exports, … })`, `TemporalModule(name)({ contract,
activities, workflows, … })`, `AmqpModule(name)({ contract, handlers, … })`.
It is di's own `Module(name)({...})` that also takes the starter's fields:
it appends the starter to `imports`, prepends the router / activities /
handlers **provider** to `provides`, adds the runtime port to `exports`, and
hands those tuples to `Module(name)` — whose return type is the sugar's,
spelled once. From [`examples/order-api`](/examples/order-api):

```ts
export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  imports: [ApplicationModule, PersistenceModule],
  exports: [Logger],
});
```

The kernel and both gates see nothing new — `OrderApi` is a `Module`, and
`await runMain(OrderApi, { unit: RequestModule })` is the whole `main.ts`. The
plain starter (`http({ router })`, `temporal({...})`, `amqp({...})`) stays
exported as the primitive the sugar delegates to; the sugar is syntax over
the same module, not a second way.

## The port-and-provider sugar

What the application supplies to a starter — a router, an activities record,
a handlers record, a config slice — is a **service on a port**, and each
starter ships one call that mints the port and returns di's own provider
builder:

- `HttpRouter(contract)(name)(deps, { sync })`
- `TemporalActivities(contract)(name)(deps, arm)`
- `AmqpHandlers(contract)(name)(deps, arm)`
- `Config.provider(name)(schema)`

The first call fixes the contract (or schema), the second mints
`class extends Port(name)<Service> {}` and hands back `Provider(port)`, so the
last call is `Provider(port)(deps, arm)` exactly as everywhere else in the
graph, and the provider carries its port typed as `provider.port` for
whoever needs to name it. The class line and its service type are what
disappear from application code; the port stays a real di port, private or
exported like any other.

**The contract types the record, and nothing wraps a leaf.** An oRPC procedure
is a plain `Result`-returning function typed by the contract at the call — the
starter does `implement`, `.result()` and `os.router`. A Temporal activity is
a plain function — the starter calls `declareActivitiesHandler`. An AMQP
handler is a plain function — `WorkerInferHandlers` accepts one bare. An
application never writes `implement`, `os.…`, `declareHandler` or
`declareActivitiesHandler`, and a typo'd or missing procedure is a compile
error at the record.

## Why `needs` disappeared

The kernel's `Runtime` has a `needs` field, and `start`'s gate checks it
against the module's exports. **No shipped starter uses it any more.** Each
takes the application's router / activities / handlers as a port its runtime
provider _depends on_ through di — `Provider(HttpRuntime)([HttpConfig, HttpHandler], …)` where `HttpHandler`
is built from the router port, `Provider(AmqpRuntime)([AmqpConfig,
options.handlers], …)` — so their `Needs` is `never` and `RuntimeHost.ctx`
goes unread.

The reason is not tidiness. A port's service type is fixed at declaration, so
a runtime with application-specific `needs` — "I need whatever this
application's router port is" — could not ship its port: `HttpRuntime` has to
be one class in `@btravstack/http`, and its type cannot mention a port only
the application knows. Making the router a dependency of the runtime's
provider moves that knowledge to where it exists — the composition root that
provides the router — and di's own gate checks it there: a root that imports
`http({ router })` without providing the router carries an unmet need `start`
refuses. The kernel keeps `Runtime.needs`, `RunUnit`'s typed `ctx` and the
`UNSATISFIED RUNTIME NEEDS` arm as the general contract for a hand-rolled
runtime; the starters simply do not need them.

## What a starter does not do

Each starter's README has a _"What it does not do"_ list, and the pattern is
the same across them: no `Result` → transport mapping (see [The kernel maps
nothing](/explanation/the-kernel-maps-nothing)), no middleware in front of the
library's own, no second transport variant (HTTPS, HTTP/2 — terminate TLS at
the ingress). Two things were removed on the way and are worth naming so a
missing feature reads as a decision:

- **Hono** was `@btravstack/http`'s router until a review found it routed
  exactly one pattern to oRPC's fetch adapter and `404`'d the rest — which
  `@orpc/server/node`'s `RPCHandler.handle(req, res, { prefix })` plus the
  runtime's own `404` do with two dependencies fewer, and no
  `overrideGlobalObjects` footgun to disarm.
- **`Config.boolean`** was removed for having no consumer. A field the
  starters do not bind and no example reads is surface without a reason.

## Where to go next

- The runtimes' shared thesis, and what one of them taught the drain:
  [One process, one runtime](/explanation/one-process-one-runtime).
- Why a starter's libraries are peers, not dependencies:
  [Peer dependencies](/explanation/peer-dependencies).
