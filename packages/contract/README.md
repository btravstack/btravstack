# @btravstack/contract

> Contract-level markers shared by a client and the server that implements
> it: declare **whether** a procedure requires an authenticated caller, and
> nothing about who that caller is. Zero dependencies, zero peers — a client
> can take a contract without the server, and any transport's contract can use
> the same marker.

```sh
pnpm add @btravstack/contract
```

Node `>=20`. Not yet published: this repository has not cut a release yet.

## Usage

```ts
import { authenticated } from "@btravstack/contract";

export const contract = {
  orders: authenticated({ place, find }),
  customers: { find, quote: authenticated(oc.input(…).output(…)) },
};
```

A marked record protects every procedure beneath it; a marked procedure
protects itself. Apply `authenticated` after a builder chain is finished,
never inside one.

**The contract says whether a route is protected; the application's
`httpAuth<Identity>()` says what the principal is.** No identity type is named
here, so nothing about the server's own view of a caller reaches a client, and
enriching it is never a contract change.

The marker is **identity-based** — a `WeakSet`, no property on the node — which
is why a package shipping a marked contract takes this one as a **peer**
dependency rather than an ordinary one: two copies would mean two registries,
and a contract marked by one reading unmarked to the other is a protected route
served open. The registry is copy-proof against that anyway (it hangs off
`globalThis` under `Symbol.for("@btravstack/contract/marked")`, so every copy
shares one `WeakSet`), so a stray second copy costs a compile error on the
mismatched marker symbol, not an open route.

## License

[MIT](./LICENSE) © Benoit TRAVERS
