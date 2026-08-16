---
title: Ambient data, injected capabilities
description: Why the kernel's AsyncLocalStorage record holds four fields of data and never a service, who is meant to read it, and the lint rule that does not exist yet.
---

# Ambient data, injected capabilities

> **Explanation.** This page explains the kernel's second thesis — what goes in
> the ambient store, what never does, and why the line sits where it does. For
> the task, see [Read the ambient unit from an
> adapter](/how-to/read-the-ambient-unit); for the record's shape, see
> [`UnitMeta` and `UnitRecord`](/reference/core/runtime).

The kernel opens one `AsyncLocalStorage` store per unit of work. It holds a
small, fixed record — `UnitRecord`, four fields — and nothing else:

```ts
type UnitRecord = {
  readonly unitId: string;
  readonly traceId: string;
  readonly tenantId: string | undefined;
  readonly deadline: number | undefined;
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
through `currentUnit()` is a dependency the provider's `deps` array does not
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
- `deadline` is a timestamp a runtime may pass so an adapter can budget a
  remote call against what is left.

There is no `Map`, no `set()`, no way for application code to add a field. A
record that could grow would be a service locator with a smaller name.

## Who reads it

Legitimate readers are **infrastructure adapters only** — the logger, the
OpenTelemetry exporter, the database adapter. They sit at the edge, they are
already coupled to the process they run in, and annotating their output with
the current unit is their job:

```ts
const log = (message: string): void => {
  const unit = currentUnit();
  process.stderr.write(
    `${JSON.stringify({ message, traceId: unit?.traceId })}\n`,
  );
};
```

Application code — a use case, a domain service — is not meant to call
`currentUnit()`. If a use case needs the tenant, the tenant is an argument or a
port, declared like everything else it depends on. The store is for the code
that would otherwise have to thread a trace id through every signature in the
codebase to reach the one place that writes it out.

The shipped runtimes are written to that rule. `@btravstack/http` opens a
unit per request, `@btravstack/temporal` one per activity attempt and
`@btravstack/amqp` one per delivery, and each injects nothing — a handler is a closure
over the services its provider declared, and the ambient record is what an
adapter underneath reads.

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
