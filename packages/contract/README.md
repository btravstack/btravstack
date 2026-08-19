# @btravstack/contract

> Contract-level markers shared by a client and the server that implements
> it: declare that a procedure requires an authenticated principal, and let
> the handler's type carry it. Zero dependencies, zero peers — a client can
> take a contract without the server, and any transport's contract can use
> the same combinator.

```sh
pnpm add @btravstack/contract
```

Node `>=20`. Not yet published: this repository has not cut a release yet.

## Usage

```ts
export type Principal = { readonly userId: string };
const { authenticated } = auth<Principal>();

export const contract = {
  orders: authenticated({ place, find }),
  customers: { find, quote: authenticated(oc.input(…).output(…)) },
};
```

A marked record protects every procedure beneath it; a marked procedure
protects itself. Apply `authenticated` after a builder chain is finished,
never inside one.

The marker is **identity-based** — a `WeakSet`, no property on the node — which
is why a package shipping a marked contract takes this one as a **peer**
dependency rather than an ordinary one: two copies would mean two registries,
and a contract marked by one reading unmarked to the other is a protected route
served open. The registry is copy-proof against that anyway (it hangs off
`globalThis` under `Symbol.for("@btravstack/contract/marked")`, so every copy
shares one `WeakSet`), so a stray second copy costs a compile error on the
mismatched principal type, not an open route.

## License

[MIT](./LICENSE) © Benoit TRAVERS
