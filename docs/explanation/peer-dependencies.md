---
title: Peer dependencies
description: Why unthrown is a peer dependency rather than a regular one — identity, instanceof, and a Result type that must be yours.
---

# Peer dependencies

```sh
pnpm add @btravstack/di unthrown
```

`unthrown` is declared as a **peer** dependency, so installing `di` means
installing both. This page is the reasoning.

## The `Result` must be _your_ `Result`

Every fallible operation in `di` returns an unthrown `Result`, and — the
half that matters — your code _continues_ those values: a `make` you write
returns a `Result` that `di`'s build pipeline `flatMap`s; the `Result` an
entry point hands back is one your code `match`es. The values cross the
package boundary in **both directions**, constantly.

Were `unthrown` a regular dependency, your application and `di` could resolve
**two copies** of it — different major versions declared, or a package
manager that deduplicates less aggressively than pnpm. Two copies means two
`Result` identities. TypeScript's structural typing might forgive some of it;
runtime behaviour will not: combinators from one copy receiving the other's
values, `instanceof`-based narrowing quietly false, two `TaggedError` worlds
whose pattern tags never match. The failure mode is not an error message — it
is a `match` arm that silently never fires.

A peer dependency is the package-manager-level statement that rules this out:
**there is one `unthrown` in this application, owned by the application, and
`di` links against it.** Your lockfile pins its version once; `di`'s declared
range (`^5.0.0`) only constrains compatibility.

## Why not zero dependencies instead

The alternative — `di` shipping its own internal result type, or throwing
like everyone else — was rejected because the error channel is not an
implementation detail here; it is half the design.
[`E` is a typed channel](/explanation/failures-vs-defects) your `make`
functions feed and your `match` sites consume, and
[defects](/reference/wiring-defects) need somewhere to go that is not your
error union. Reinventing that inside `di` would give it a private dialect of
the discipline the rest of a btravstack application (and
[`entity`](https://btravstack.github.io/entity/), which makes the same
choice for the same reason) already speaks. Sharing the vocabulary is the
point; peering is how you share a vocabulary safely.

## Why the examples install it themselves

Each [example package](/examples/) declares `unthrown` in its own
`package.json` even though `di` already requires it. That is the peer
contract seen from the consumer's side: a peer is **the consumer's
dependency**, not a transitive one, and with pnpm's strict linking an
undeclared peer is simply not importable. Your application does the same —
which is why the install line at the top of every guide names both packages.
