# `examples/` — a clean-architecture slice as the integration suite — Design

**Date:** 2026-08-11 (revised the same day)
**Status:** Approved, pending implementation plan
**Repo:** `btravstack/start`
**Supersedes:** the first revision of this document, which proposed two
dependency-free examples (`http-api` + `worker`). That shape was built through
Task 2 and is being replaced; see [Why the first shape was replaced](#why-the-first-shape-was-replaced).

## Purpose

Every sibling repo (`btravstack/di`, `btravstack/entity`) carries an `examples/`
directory of private workspace packages that are both documentation and
integration tests. This repo needs them for a reason specific to what it ships:
**every runtime in the kernel's own suite is `Runtime<never>`.** `testRuntime`
declares no needs, so `Context<InstanceType<Needs>>` and the trailing phantom
needs-gate on `start` are never exercised against a runtime with real
dependencies.

The first revision proved that point and then some — building one real runtime
surfaced five rough edges in the kernel's public API that no unit test had found.
This revision goes further: the examples become a **clean-architecture slice
across the whole btravstack stack**, so they exercise `@btravstack/start` in the
composition it was designed for rather than in isolation.

## The layering

One workspace package per layer. The package boundary is the point: it is what
makes the dependency direction a **build error** rather than a convention a
reviewer has to police. This mirrors `@btravstack/entity`'s
`billing-domain → billing-persistence → billing-api` split.

```
examples/
  order-domain/          @btravstack/start-example-order-domain
      entities, value objects, domain errors.       deps: unthrown
  order-application/     @btravstack/start-example-order-application
      ports + use cases + ApplicationModule.        deps: domain, di, unthrown
  order-infrastructure/  @btravstack/start-example-order-infrastructure
      Prisma adapter + PersistenceModule.           deps: application, @unthrown/prisma
  order-api/             @btravstack/start-example-order-api
      oRPC contract + runtime + composition root.   deps: application, infrastructure,
                                                          @unthrown/orpc, @btravstack/start
  order-worker/          @btravstack/start-example-order-worker
      queue runtime + composition root.             deps: application, infrastructure,
                                                          @btravstack/start
```

`order-domain` importing Prisma, or `order-application` importing `@orpc/server`,
does not compile. That is the demonstration.

**Ports live in `order-application`, not in infrastructure.** A port is the
vocabulary the application defines for what it needs — never what an adapter
happens to provide. `order-infrastructure` provides `OrderRepository`; nothing in
the application layer knows Prisma exists.

**Two composition roots, one application.** `order-api` and `order-worker` each
compose `ApplicationModule` with `PersistenceModule` and boot it under a
different `Runtime`. That is the kernel's "one process, one runtime" thesis made
concrete: the same wiring, two deployables.

## Dependency choices, and why

**Persistence is `@unthrown/prisma` over in-memory SQLite**
(`@prisma/adapter-better-sqlite3`), exactly as that package's own suite runs.
`@unthrown/drizzle` was rejected for an example: it requires a running Docker
daemon via `@testcontainers/postgresql`, which is a documented departure from the
monorepo's self-contained-suite convention. An example whose job is to be cloned
and run must not need Docker. The Prisma schema is generated at test time
(`prisma generate && vitest run`, the pattern `@unthrown/prisma` itself uses) and
the generated client is gitignored.

**Transport is `@unthrown/orpc`.** Its peer range is `^2.0.0-beta` on
`@orpc/client` and `@orpc/server`, and oRPC's `latest` dist-tag is the 1.x line —
so the catalog must pin an explicit beta. It pins **`2.0.0-beta.23`**, the
version `@unthrown/orpc` is built and verified against in the `unthrown` repo.
Installing `latest` would resolve 1.15.0 and fail this repo's
`strictPeerDependencies`.

**The examples deliberately break the kernel's zero-dependency rule.** That rule
binds `packages/start`, which still has none. Examples are private, unpublished,
and exist to show the library in real conditions — the whole point of the
redirection.

## Why the first shape was replaced

The first revision's `examples/http-api` implemented a `Runtime` over `node:http`
with a hand-rolled router and an in-memory `Map` repository. It worked, was
reviewed, and is green. It is being removed rather than kept alongside, on the
judgement that one transport example is enough and a realistic one teaches more.

What is preserved: the oRPC runtime also declares non-empty `needs`, so the
`Context<InstanceType<Needs>>` and needs-gate proof — the original reason for
adding examples — carries over intact, along with its `@ts-expect-error` negative
case.

What is lost, stated plainly: the zero-dependency "how to implement the `Runtime`
contract from scratch" reference. A third party writing a new runtime now has an
oRPC-shaped example to read instead of a bare one. Accepted deliberately.

Also resolved by the removal: an open Important finding against the `node:http`
runtime (its response-ordering guard had no test) disappears with the code it
described.

## What the examples must prove

1. **A runtime with non-empty `needs`** — `Context<InstanceType<Needs>>` and the
   phantom gate, asserted in both directions with `@ts-expect-error`.
2. **Layering enforced by the build** — a `@ts-expect-error` fixture proving the
   domain layer cannot import infrastructure.
3. **`Result` → transport, at the edge and only there.** oRPC maps a domain `Err`
   to a typed, inferable `ORPCError`; the worker maps the same `Err` to a
   dead-letter. One `Result`, two transports, the kernel involved in neither.
4. **Real persistence errors stay in the domain channel.** A unique-constraint
   violation surfaces as `@unthrown/prisma`'s `UniqueConstraintViolation` and is
   translated at the adapter boundary into the application's own error — proving
   that infrastructure vocabulary does not leak into the domain.
5. **Per-request units** — distinct trace ids from the ambient record, read by a
   logger adapter while use cases take their collaborators from `Context`.
6. **Draining a real server** — in-flight request completes, the `DrainReport`
   arithmetic is pinned exactly, a hung request is abandoned at the deadline.
7. **Probes alongside a real runtime**, including `/readyz` flipping 503 before
   the runtime stops accepting.

## Non-goals

- Nothing published; every example package is `private: true`, no changeset.
- No Docker, no external services, no network.
- Not a replacement for the kernel's own unit and invariant suites.
