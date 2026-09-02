---
title: Ambient data, injected capabilities
description: Why the kernel's AsyncLocalStorage record holds five fields of data and never a service, who is meant to read it, and the lint rule that does not exist yet.
---

# Ambient data, injected capabilities

> **Explanation.** This page explains the kernel's second thesis — what goes in
> the ambient store, what never does, and why the line sits where it does. For
> the task, see [Read the ambient unit from an
> adapter](/how-to/read-the-ambient-unit); for the record's shape, see
> [`UnitMeta` and `UnitRecord`](/reference/core/runtime).

The kernel opens one `AsyncLocalStorage` store per unit of work. It holds a
small, fixed record — `UnitRecord`, four fields — and nothing else:

<!-- doctest: signature=@btravstack/core -->

```ts
type UnitRecord = {
  readonly unitId: string;
  readonly traceId: string;
  readonly tenantId: string | undefined;
  readonly signal: AbortSignal;
};
```

`currentUnit()` reads it, and returns `undefined` outside a unit. **Services
never go in it.** No logger, no repository, no request-scoped anything. That is
the whole rule, and this page is about why the rule holds there and not one
step in either direction.

## The line

The obvious objection is that `AsyncLocalStorage` is exactly how most Node
frameworks smuggle a request context to code that never asked for it, and that
a container which forbids hidden dependencies is being inconsistent by using
it at all. The objection is right about the mechanism and wrong about what it
carries.

What `di` exists to prevent is **hidden dependencies**: code that secretly needs
a collaborator it never declared and therefore cannot be tested without it. A
service pulled from an ambient store is precisely that — a repository reached
through `currentUnit()` is a dependency the provider's `inject` record does not
name, so the test double has nowhere to go, and the type checker's whole
argument about the graph is quietly false.

A trace id is not a collaborator. There is no substitutability question, no
test double to swap in, no interface behind it. It is a value that describes
_this_ unit, and every unit has one. Reading it hides nothing about what the
code depends on, because the code depends on nothing — it annotates a log line
with a fact about where it is running.

So the line is: **ambient carries data, the di `Context` carries
capabilities**. A repository through the store is the untestable coupling. A
tenant id read by the Postgres adapter is not.

## Why exactly these four

Each field is a fact the kernel either mints or is handed at `run`, and each is
one an adapter genuinely needs without being able to declare it.

- `unitId` is minted by the kernel, once per unit, and is always unique. It is
  what a reader uses to tell two units apart, and it costs the runtime nothing.
- `traceId` is the **correlation** id — the one field a runtime may supply,
  because it carries an id from _outside_ the process (a `traceparent` header,
  a message property) so a line logged here joins a trace that started
  elsewhere. It defaults to `UnitMeta.id`, which is why `id` must be unique per
  unit unless a `traceId` is given; see [the two contracts a runtime
  owes](/how-to/write-a-runtime).
- `tenantId` is the one piece of application data allowed in, because the
  adapters that need it — a database adapter choosing a schema, an exporter
  tagging a span — are exactly the readers the store is for.
- `signal` is the **very** `AbortSignal` the kernel hands the unit's work
  callback — one controller, two ways to reach it — fired at the drain
  deadline, or at once on a path that skips the drain.

There is no `Map`, no `set()`, no way for application code to add a field. A
record that could grow would be a service locator with a smaller name.

### Is a signal really data?

It is the one field that looks like a capability, so it is worth saying why it
is not. The test this page uses everywhere else is substitutability: a
collaborator has an interface behind it, a test double to swap in, a
`inject` entry it should have been declared through. An `AbortSignal`
has none of those. It is a fact about _this_ unit — "the process has stopped
waiting for you". Nothing about the code that reads it changes shape when it is absent; the
`?.` in `currentUnit()?.signal` is the whole of the fallback.

The reason it is on the record at all is that **the work callback is not
always where the work is**. `@btravstack/http-server` opens the unit around its own
listener, so it passes the signal as the handler's third parameter and never
needs the record. `@btravstack/temporal-worker` and `@btravstack/amqp-worker` are
middleware-shaped: the kernel's work callback is the library's `next()`, and
an activity or a handler has no parameter to receive a signal through. The
alternative was injecting a context — an extra first argument the Temporal or
AMQP contract does not type — which is exactly the hidden-dependency shape
this page argues against, so it was rejected.

A transport's own cancellation is a **different clock** and stays separate.
Temporal's `Context.current().cancellationSignal` fires on a workflow-side
cancellation, and on worker shutdown after `shutdownGraceTime`; AMQP has no
cancellation story at all, since an un-acked delivery is redelivered, which is
recovery rather than cancellation. The two are honoured together, not one
standing in for the other.

## Who reads it

Legitimate readers are **infrastructure adapters only** — the logger, the
OpenTelemetry exporter, the database adapter. They sit at the edge, they are
already coupled to the process they run in, and annotating their output with
the current unit is their job.

The logger is no longer a hypothesis about that rule: it is
[`@btravstack/observability`](/reference/observability), and
`createLogger` is the reference reading of the record —

<!-- doctest: skip — an excerpt of packages/observability/src/logger.ts, which the gate compiles -->

```ts
const write = (level, message, attributes, cause) => {
  if (severity(level) < floor) return;
  const unit = currentUnit();
  sink({ level, message, attributes, cause, time: Date.now(), unit });
};
```

— read **per call**, never captured at construction. That detail is the whole
reason the rule is worth having: one logger is built per scope, every unit the
kernel opens has its own record, and a captured one would stamp the first
unit's trace id on every line thereafter. Application code depending on
`Logger` writes `logger.info("placing an order", { orderId, quantity })` and
never mentions correlation; the adapter underneath is the only thing that
reads the store.

Application code — a use case, a domain service — is not meant to call
`currentUnit()`. If a use case needs the tenant, the tenant is an argument or a
port, declared like everything else it depends on. The store is for the code
that would otherwise have to thread a trace id through every signature in the
codebase to reach the one place that writes it out.

The shipped runtimes are written to that rule. `@btravstack/http-server` opens a
unit per request, `@btravstack/temporal-worker` one per activity attempt and
`@btravstack/amqp-worker` one per delivery, and each injects nothing — a handler is a closure
over the services its provider declared, and the ambient record is what an
adapter underneath reads. For the two middleware-shaped ones the record is
also the only route to the unit's `AbortSignal`, since they call `next()`
unchanged; `@btravstack/http-server` passes the same signal as an argument instead.

## The lint rule that does not exist

Application code reading the store is meant to be a lint error, in the spirit
of `unthrown/no-catch-all-pattern` stating unthrown's own default. **That rule
is not written.** It needs a way to identify an adapter — a naming convention,
a directory convention, a marker — and this stack has not established one. So
today it is a documented convention held by review, and this page states that
plainly rather than describing enforcement that is not there.

It is listed under _Deferred, deliberately_ in the repository's spec, and the
missing piece is the convention, not the rule.

## What was rejected

**A per-request `Context` in the store.** The tempting shortcut is to put the
forked di `Context` itself into `AsyncLocalStorage`, so a handler anywhere can
`get()` a request-scoped port. That is a service locator, and it deletes the
one thing the container is for. The kernel's answer to per-request services is
[`StartOptions.unit`](/how-to/open-a-per-request-scope): a module the kernel
forks around every unit and hands to the unit's work as an ordinary `Context`,
so a request-scoped provider reaches a handler through the argument list, not
the store.

**A richer record.** A store that also carried the request, the user, the
locale — every framework's `ctx` — was the first thing not to build. Each
extra field is one more fact application code is tempted to read ambiently
instead of declaring, and the record's smallness is what makes the rule
followable.

## Where to go next

- The unit the record belongs to, and the two contracts a runtime owes about
  it: [The kernel maps nothing](/explanation/the-kernel-maps-nothing).
- Per-request services done the declared way:
  [Open a per-request scope](/how-to/open-a-per-request-scope).
