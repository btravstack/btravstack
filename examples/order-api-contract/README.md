# `@btravstack/core` example: the order API contract

The oRPC contract — the wire shapes and the declared error codes — in a package
of its own, depending on `@orpc/contract` and nothing else.

```text
src/contract.ts        the contract: inputs, outputs, and the errors a client may branch on
src/layering.test-d.ts the dependency rule, as a compile error
src/__tests__/test-fixtures.ts   a client built from this package alone, over a stub `fetch`
```

## Why it is not part of `order-api`

A contract is a **shared artifact**: the point of declaring one before any
implementation exists is that a client and a server both depend on it. While it
sat in `order-api/src/contract.ts`, a would-be client could only reach it by
depending on the whole transport — the router, the di wiring, the Prisma-backed
repository, the kernel — none of which it has any business installing.

So the arrow points the other way from every other one in this example set:

```text
   order-api          any client
       └────────┬─────────┘
                ▼
       order-api-contract        ← depends on nothing but @orpc/contract
```

`src/layering.test-d.ts` is that sentence as a compile error: it imports
`@btravstack/example-order-api` under a `@ts-expect-error`, so the day
this package gains a dependency on the server it implements, `test:types` fails
because the directive stops being used.

## The proof is a client, not a claim

`src/client.spec.ts` builds a real oRPC client whose types come from
`RouterContractClient<typeof contract>` — the contract, not
`RouterClient<typeof orderRouter>` — and drives it over a stub `fetch` that
answers the RPC protocol with a `Map` behind it. Nothing from `order-api` is
imported, and both channels survive: the declared `NOT_FOUND` arrives as an
`Err` carrying its `data`, because the response marks it _inferable_ exactly as
a real server would.

`@orpc/client` and `@unthrown/orpc` are **dev** dependencies here. A client
picks them itself; what it takes from this package is the contract.
