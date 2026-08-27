---
"@btravstack/amqp-worker": minor
"@btravstack/cache": minor
"@btravstack/config": minor
"@btravstack/contract": minor
"@btravstack/core": minor
"@btravstack/di": minor
"@btravstack/http-server": minor
"@btravstack/mailer": minor
"@btravstack/observability": minor
"@btravstack/prisma": minor
"@btravstack/storage": minor
"@btravstack/temporal-worker": minor
"@btravstack/testing": minor
---

`HttpHandler` is a set port, so HTTP can carry more than one protocol.

It was a single function, and its own TSDoc said why: "there is one way to
answer HTTP here, oRPC, so nothing outside this package provides or names it."
That was true of the package and is no longer the intent — GraphQL and htmx
fragments are coming, and neither is an oRPC procedure.

```ts
type HttpAnswerer = {
  readonly prefix: `/${string}`;
  readonly handle: (request, response, signal) => PromiseLike<unknown>;
};
```

Every protocol served in the process contributes one member, and the runtime
routes each request to the one whose prefix matches **longest**. `/rpc` owns
`/rpc` and everything under it; a `/` fragment answerer takes the rest.

## Why routing rather than a chain

A graph holds exactly one runtime (thesis #1), so several protocols cannot be
several runtimes — they are several answerers under one. The open question was
how a request finds its answerer. A chain of "answer or decline" would have
made ordering a property of provider registration across modules, visible in no
single line, and would have needed the matched signal the port deliberately
discards. Longest-prefix routing needs neither: nesting is the expected shape,
so there is nothing to order.

- A mount point is a **path segment**, not a string prefix — `/rpc` does not
  own `/rpcx`.
- A trailing slash is the same mount, so `/rpc` and `/rpc/` collide, and two
  answerers on one mount is a `RuntimeStartFailed` at `listen` rather than a
  coin toss.
- A path no mount covers is the runtime's own `404`, written before any
  answerer is consulted. A path a mount does cover, whose answerer declines, is
  the same `404` it always was — oRPC's behaviour is unchanged.

## What a composition root has to change

**`HttpRuntime` now resolves `HttpHandler`**, because a member contributed by a
sibling module is not visible from inside the starter's own — `resolves` is the
kernel's existing mechanism for what a runtime reads out of the application
context. So the root must export it:

```ts
Module("OrderApi")({ imports: [http()], exports: [HttpRuntime, HttpHandler] });
```

`HttpModule` adds it for you, and `start`'s `UNSATISFIED RUNTIME PORTS` names
the port when a hand-written root forgets — that arm had no shipped starter
declaring anything until now.

`HttpHandler` is exported from the package for the first time, since a second
protocol's package has to name it.

## An answerer outside a contract is public

`@btravstack/contract`'s marker is what says which scheme protects an oRPC
procedure. A GraphQL operation or an HTML fragment has no such statement, so
its routes are public unless the answerer brings authentication of its own —
exactly as an unmarked procedure is public, and with the same absence of a gate
for "you forgot". What the common way across protocols should be is #179's
question, and is deliberately not answered here.
