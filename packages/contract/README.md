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

## License

[MIT](./LICENSE) © Benoit TRAVERS
