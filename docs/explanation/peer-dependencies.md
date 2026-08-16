---
title: Peer dependencies
description: Why di, config, core and unthrown are peers of everything in this stack, why each starter peers on its transport library too, and the dual-copy hazard that makes a regular dependency the wrong choice.
---

# Peer dependencies

> **Explanation.** This page explains why the packages you install from this
> stack declare each other — and `unthrown` — as **peer** dependencies rather
> than regular ones. For what to install for which deployment, see
> [Packages and install](/reference/packages).

```sh
pnpm add @btravstack/core @btravstack/config @btravstack/di unthrown
```

Four packages, not one, and the reason is the same for every arrow in the
graph.

## The `Result` must be _your_ `Result`

Every fallible operation in this stack returns an unthrown `Result`, and — the
half that matters — your code _continues_ those values: a `make` you write
returns a `Result` that `di`'s build pipeline `flatMap`s; the `Result` an
entry point hands back is one your code `match`es; the `Result` a handler
returns is what a runtime folds into a response. The values cross package
boundaries in **both directions**, constantly.

Were `unthrown` a regular dependency of each package, your application and
the packages could resolve **two copies** of it — different ranges declared,
or a package manager that deduplicates less aggressively than pnpm. Two copies
means two `Result` identities. TypeScript's structural typing might forgive
some of it; runtime behaviour will not: `isResult` from one copy does not
recognise the other's values, `instanceof`-based narrowing is quietly false,
two `TaggedError` worlds' pattern tags never match. The failure mode is not an
error message — it is a `match` arm that silently never fires.

A peer dependency is the package-manager-level statement that rules this out:
**there is one `unthrown` in this application, owned by the application, and
every package links against it.** Your lockfile pins its version once; a
package's declared range (`^5.0.0`) only constrains compatibility.

## Port identity is the same hazard, one level up

`di` has its own identity to protect. A port is a class whose runtime key is
its `portId` and whose type-level brand is a module-private symbol; a built
context is a flat map keyed by those ids. Two copies of `@btravstack/di` in
one process would be two `Port` factories, two `Scope` classes, two brands —
and a `Provider` built by one copy handed to a `Module` built by the other
would type-check structurally and misbehave at runtime, exactly the class of
surprise the container exists to remove. So `di` is a peer of everything that
speaks it: `config` peers on `di`; `core` peers on `di` and `config`; the
starters peer on all three.

The dependency arrows only ever run one way — `core` → `config` → `di`, never
back — and each is a peer, so an application holds **one copy** of each and
the whole stack agrees on what a port, an `Env`, a `Runtime` is.

## Why not zero dependencies instead

The alternative — each package shipping its own internal result type, or
throwing like everyone else — was rejected because the error channel is not an
implementation detail here; it is half the design. `E` is a typed channel your
`make` functions feed and your `match` sites consume, and defects need
somewhere to go that is not your error union. Reinventing that inside `di`
would give it a private dialect of the discipline the rest of the application
already speaks. Sharing the vocabulary is the point; peering is how you share
a vocabulary safely.

Zero _regular_ dependencies is what the peer choice buys. `di`, `config` and
`core` depend on nothing but `node:` builtins; there is no transitive tree
under them to audit, pin or deduplicate. `config`'s `Config.object` is a
hand-rolled Standard Schema for exactly this reason — the package accepts any
Standard Schema, and brings none.

## Starters peer on their transport, too

A starter is, by definition, the exception to "no dependencies" — and it keeps
the exception a peer. `@btravstack/http` peers on `@orpc/server`,
`@orpc/contract` and `@unthrown/orpc`; `@btravstack/temporal` on
`@temporal-contract/*` and `@temporalio/*`; `@btravstack/amqp` on
`@amqp-contract/worker` and `@opentelemetry/api`. The reasoning is the same
`Result` reasoning applied to a contract: the oRPC contract your router
implements, the Temporal activities your worker registers, the AMQP handlers
your consumer runs are values that cross from your code into the starter and
back, typed by the transport library. One copy of that library, owned by the
application, is the only arrangement under which those values are the same
values on both sides.

## Why the examples install them themselves

Every example workspace declares `unthrown` — and `@btravstack/di`, when it
uses one directly — in its own `package.json`, even though the packages it
imports already require them. That is the peer contract seen from the
consumer's side: a peer is **the consumer's dependency**, not a transitive
one, and with pnpm's strict linking an undeclared peer is simply not
importable. Your application does the same — which is why the install line
at the top of every guide names the peers alongside the package.
