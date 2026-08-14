# request-scope

Lifetime management: a connection pool acquired once, under `Module.scoped`,
and a per-request transaction layered over the already-built parent with
`Module.forkScope` — once per request.

```sh
pnpm --filter @btravstack/example-request-scope test
pnpm --filter @btravstack/example-request-scope typecheck
```

## What it shows

`src/index.ts`, top to bottom:

- **Two different lifetimes, two different modules.** `App` provides
  `ConnectionPool` with the resourceful `acquire`/`release` arm — opened
  once, for the life of the process. `Request` provides `Transaction`, also
  resourceful, but built fresh for every request and depending on
  `ConnectionPool` without providing it itself.
- **`Module.forkScope` is what makes that legal.** `Request`'s own `Needs`
  still lists `ConnectionPool` — nothing in that module supplies it — but
  `forkScope` resolves it from the already-_built_ parent `Context` it is
  handed, rather than from `Request`'s own (empty) provider set. That is the
  entire reason to fork over a built parent instead of building `Request` on
  its own.
- **A fresh scope per fork.** Each call to `Module.forkScope` opens its own
  scope, seeded with the parent context but registering only _this_ fork's
  own finalisers on it. Closing that scope therefore releases only what this
  fork acquired — the parent's pool is never touched.

## What the spec proves

Both facts in the brief are about _timing_, not just wiring, so
`src/index.spec.ts` proves them empirically:

- **The per-request resource releases after each request, while the parent
  stays up.** After every `handleRequest` call the test checkpoints that the
  most recent lifecycle event is `"txn-released"` and that `"pool-released"`
  has not appeared yet — for three separate, sequential requests over the
  same parent.
- **The parent releases last.** The full event timeline asserted at the end
  is `pool-acquired`, then three `txn-acquired`/`txn-released` pairs, then
  `pool-released` — once, after every request, never before.

A second test checks the other half of forking over a _built_ parent: two
sibling requests both read `ConnectionPool` off the same parent context, so
their transactions share one connection lineage rather than each fork
constructing its own copy.
