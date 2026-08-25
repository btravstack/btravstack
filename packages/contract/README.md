# @btravstack/contract

> Contract-level markers shared by a client and the server that implements
> it: declare **which security schemes** a procedure accepts and which scopes
> each must grant, and nothing about who the caller is. Zero dependencies,
> zero peers — a client can take a contract without the server, and any
> transport's contract can use the same marker.

```sh
pnpm add @btravstack/contract
```

Node `>=20`.

## Usage

<!-- doctest: prelude
import { oc } from "@orpc/contract";
import { z } from "zod";
const order = z.object({ id: z.uuidv7() });
const place = oc.input(order).output(order);
const find = oc.input(order).output(order);
-->

```ts
import { authenticated } from "@btravstack/contract";

export const contract = {
  orders: authenticated({ user: [] })({
    place,
    find,
    // Overrides the group default for itself: a `user` token needs the scope,
    // or a `service` token needs nothing.
    export: authenticated(
      { user: ["orders:export"] },
      { service: [] },
    )(oc.output(z.object({ csv: z.string() }))),
  }),
  customers: { find },
};
```

`authenticated` is **curried**: it takes one or more OpenAPI security
requirements — a scheme name mapped to the scopes it must grant — and hands
back the function that marks a node. Several requirements are **ORed**, tried
in the order given. A marked record is the default for every procedure beneath
it; a marked procedure **replaces** that default for itself. Nearest mark
wins, which is OpenAPI's own rule. Apply it after a builder chain is finished,
never inside one.

**The contract says which schemes protect a route; the application's
`defineHttp({ authenticators })` says what each one resolves to.** No identity
type is named here, so nothing about the server's own view of a caller reaches
a client, and enriching it is never a contract change.

The marker is **identity-based** — a `WeakMap`, no property on the node — which
is why a package shipping a marked contract takes this one as a **peer**
dependency rather than an ordinary one: two copies would mean two registries,
and a contract marked by one reading unmarked to the other is a protected route
served open. The registry is copy-proof against that anyway (it hangs off
`globalThis` under `Symbol.for("@btravstack/contract/requirements")`, so every
copy shares one `WeakMap`), so a stray second copy costs a compile error on the
mismatched marker symbol, not an open route.

`isAuthenticated(node)` reads back the `Requirements` a node was marked with,
or `undefined` when nobody marked it.

## License

[MIT](./LICENSE) © Benoit TRAVERS
