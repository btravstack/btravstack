# Examples

Five small packages that are **one application booted two ways**: a clean
architecture split across four layers, deployed once as an oRPC API and once as
a queue worker — and, at the same time, exercising `@btravstack/start` end to
end from a consumer's own workspace, `workspace:*` and all.

| Package                                          | Layer     | Shows                                                                                                                                      |
| ------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [`order-domain`](./order-domain)                 | domain    | Entities and rules with no dependencies at all: branded fields, an `Entity.invariant` re-checked on every path, failures as values.        |
| [`order-application`](./order-application)       | use cases | Ports declared by the caller, interactors, and an `ApplicationModule` whose `OrderRepository` is deliberately an **unmet need**.           |
| [`order-infrastructure`](./order-infrastructure) | adapters  | A Prisma-backed repository over in-memory SQLite, translating P-codes into the domain's vocabulary and closing the application's one need. |
| [`order-api`](./order-api)                       | runtime   | The first deployment: an oRPC router over `node:http`, a scope forked per request, and `Result` → `ORPCError`.                             |
| [`order-worker`](./order-worker)                 | runtime   | The second deployment: an in-memory queue worker over the **same** composition, and `Result` → ack / retry / dead-letter.                  |

## The layering, and which way the arrows point

```
    order-api                 order-worker      ← one runtime each; one process each
         └───────────┬───────────────┘
                     ▼
          order-infrastructure                  ← Prisma, SQLite, P-codes
                     │  provides OrderRepository
                     ▼
           order-application                    ← use cases, and the ports they declare
                     │
                     ▼
              order-domain                      ← entities and rules; depends on nothing
```

Every arrow points **inwards**, and the one that looks like it goes the wrong
way is the whole idea: `order-infrastructure` imports `order-application`,
because the port it implements — `OrderRepository`, spelled in the domain's
vocabulary — is declared by the caller that needs it, not by the database that
happens to satisfy it. `ApplicationModule` therefore leaves that need **unmet**,
which is not documentation but a type: `Module.scoped(ApplicationModule, …)`
does not compile until an outer module provides one.

## One application, two deployments

`OrderApiModule` and `OrderWorkerModule` are the same three lines:

```ts
imports: [ApplicationModule, PersistenceModule],
provides: [],
exports: [PlaceOrder, FindOrder, Logger],
```

Nothing in `order-application` or `order-infrastructure` differs between them,
and nothing could: the use cases return a `Result`, and what a `Result` means to
a transport is the transport's business. The kernel's headline claim — several
runtime _kinds_, one per process, over the same module — is proved here rather
than asserted, and the sharpest form of the proof is that **the same `Err`
becomes two different outcomes**:

| unthrown               | `order-api`             | `order-worker`              |
| ---------------------- | ----------------------- | --------------------------- |
| `Ok(order)`            | the procedure's output  | **ack**                     |
| `Err(InvalidQuantity)` | `INVALID_QUANTITY`      | **dead-letter**             |
| `Err(DuplicateOrder)`  | `CONFLICT`              | **dead-letter**             |
| `Defect`               | `INTERNAL_SERVER_ERROR` | **retry**, then dead-letter |

The kernel appears in neither column. `RunUnit` hands a runtime the work's own
`Result` and stays out of what it means.

## The only non-empty `needs` in the repo

`orpcRuntime` declares `[PlaceOrder, FindOrder, Logger]` and
`queueWorkerRuntime` declares `[PlaceOrder, Logger]` — two of the three the
module exports, because a runtime declares what _it_ needs. They are the **only
runtimes in this repository with a non-empty `needs`**: the kernel's own
`testRuntime` needs nothing, so `start`'s phantom rest-tuple gate — and
`RuntimeHost`'s `Context<InstanceType<Needs>>`, where a runtime names port
_classes_ while di parameterises contexts by port _instances_ — are exercised
against a real module here and nowhere else.

Both directions are pinned, in `order-api/src/needs-gate.test-d.ts` and
`order-worker/src/needs-gate.test-d.ts`: the wired call is an ordinary
two-argument one, and a module one port short fails on **arity**, naming the
missing need.

## Why these are tests, not just illustrations

Each package reads as application code, and each is covered by real specs — 57
of them, run by the repository's own `pnpm test`:

```sh
pnpm install
pnpm test        # every example's specs, alongside the kernel's own
pnpm typecheck   # includes the compile-time-only guarantees pinned with @ts-expect-error
```

Nothing is faked at the boundaries that matter. `order-infrastructure` runs
against a real Prisma client over in-memory SQLite, so a `DuplicateOrder` comes
from an actual `UNIQUE` index raising an actual P2002. `order-api` runs a real
`node:http` server and a real oRPC client over it, so the collapse of a `Defect`
to `INTERNAL_SERVER_ERROR` happens where it really happens. **No Docker, and
nothing to install**: the Prisma client is generated by the `test` script
itself.

Where a guarantee is compile-time only — an unmet port, a runtime's `needs` —
the assertion is a `@ts-expect-error` in a `*.test-d.ts` file, checked by `tsc`
rather than executed.

Nothing here is published: every package is `"private": true` and depends on the
kernel via `workspace:*`.
