---
title: Protect the API
description: Mark a procedure in the contract, declare the scheme that answers for it, read the principal in the handler — and watch the anonymous caller get a 401 you never wrote.
---

# Protect the API

> **Tutorial.** The third hands-on lesson. It assumes you finished
> [Configure and test](/tutorial/configure-and-test) and have the greeting
> service from it. We keep explanation to a minimum here and link out to it.

By the end, the contract will carry a procedure only an authenticated caller
can reach, the application will say — in one place — what its `user` scheme
resolves to, and the handler will greet the caller by the name on their
credential. The anonymous caller gets a `401` no code of yours produces.

## Step 1 — Install the contract marker

::: code-group

```sh [pnpm]
pnpm add @btravstack/contract
```

```sh [npm]
npm install @btravstack/contract
```

```sh [yarn]
yarn add @btravstack/contract
```

:::

It is a tiny package — zero dependencies — because a **client** must be able
to depend on a marked contract without pulling in any server code.

## Step 2 — Mark a procedure

Add `greetMe` to the contract: no input — the caller's identity IS the
input — and a mark saying the `user` scheme must answer for it, with no
particular scopes:

**`contract.ts`**

<!-- doctest: prelude
// The application as lesson two left it, restated so this page compiles on
// its own: the configurable Greeter and its module.
import { Config, Env } from "@btravstack/config";
import { Module, Port, Provider } from "@btravstack/di";

class Greeter extends Port("Greeter")<{
  readonly greet: (name: string) => string;
}> {}
const greetingConfig = Config.provider("GreetingConfig")(
  Config.object({ greeting: Config.string("GREETING", { default: "Hello" }) }),
);
const GreetingModule = Module("Greeting")({
  needs: [Env],
  provides: [
    greetingConfig,
    Provider(Greeter)(
      { config: greetingConfig.port },
      { sync: ({ config }) => ({ greet: (name) => `${config.greeting}, ${name}!` }) },
    ),
  ],
  exports: [Greeter],
});
-->

```ts
import { authenticated } from "@btravstack/contract";
import { oc } from "@orpc/contract";
import { z } from "zod";

export const contract = {
  hello: oc
    .input(z.object({ name: z.string() }))
    .output(z.object({ message: z.string() })),

  // The mark: the `user` scheme, no scopes required. It names no identity
  // type — nothing about the server's view of a caller reaches a client.
  greetMe: authenticated({ user: [] })(
    oc.output(z.object({ message: z.string() })),
  ),
};
```

`hello` stays public — an unmarked procedure is public, and nothing warns if
you forget a mark; the contract is the only statement of intent there is
([the reasoning](/how-to/protect-a-procedure)).

## Step 3 — Declare what the scheme resolves to

One new file. `HttpAuthenticator` builds the scheme's resolver — an ordinary
di provider, so a JWT verifier or a user directory would arrive through
`deps` — and `defineHttp` is the one door where scheme **names** meet their
resolvers. Declaring a scheme and implementing it are the same act:

**`auth.ts`**

```ts
import {
  HttpAuthenticator,
  Unauthenticated,
  defineHttp,
} from "@btravstack/http-server";
import { ErrAsync, OkAsync } from "unthrown";

/** What this deployment knows about a caller. The contract names none of it. */
export type Identity = { readonly name: string };

const userAuth = HttpAuthenticator<Identity>()({
  sync: () => (headers) => {
    const header = headers.authorization ?? "";
    const name = header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : "";
    // A real authenticator VERIFIES a token here — this one trusts it, which
    // is exactly as secure as it sounds. Swap the body; the shape stays.
    return name === "" ? ErrAsync(new Unauthenticated()) : OkAsync({ name });
  },
});

// Held whole and never destructured, as in lesson one — but no longer empty:
// the scheme names are the keys, written once.
export const api = defineHttp({ authenticators: { user: userAuth } });
```

Lesson one's `defineHttp()` moved here and grew an argument. Delete the old
`const api = defineHttp()` from `router.ts` and import this one instead.

## Step 4 — Read the principal

The router file changes in two ways: `api` now comes from `auth.ts`, and the
marked procedure's handler receives `context.principal`, typed as the
`Identity` the scheme resolves — the compiler knows which procedures are
marked, so `hello` has no principal to read:

**`router.ts`**

```ts
import { OkAsync } from "unthrown";

import { api } from "./auth.js";
import { contract } from "./contract.js";
import { Greeter } from "./greeter.js";

export const greetingRouter = api.HttpRouter(contract)(
  { greeter: Greeter },
  {
    sync: ({ greeter }) => ({
      hello: (_helpers, input) =>
        OkAsync({ message: greeter.greet(input.name) }),
      greetMe: ({ context }) =>
        OkAsync({ message: greeter.greet(context.principal.name) }),
    }),
  },
);
```

`app.ts` and `main.ts` do not change at all: the authenticators ride the
router — they are what it needs — and `HttpModule` provides them itself. A
scheme the contract names with no resolver behind it would be di's own unmet
need, refused at compile time.

## Step 5 — Get the 401

Run it (`GREETING=Ahoy PORT=3000 node src/main.ts`), then call the marked
procedure with no credential:

```sh
curl -i -X POST http://localhost:3000/rpc/greetMe \
  -H 'content-type: application/json' -d '{}'
```

```
HTTP/1.1 401 Unauthorized
```

The handler never ran — the `401` is the starter's, produced before
dispatch: the contract says `greetMe` needs a `user`, so the scheme's
authenticator ran, found no credential, and answered `Unauthenticated`, which
the starter maps to `401`. Now present a credential:

```sh
curl -X POST http://localhost:3000/rpc/greetMe \
  -H 'authorization: Bearer Ada' \
  -H 'content-type: application/json' -d '{}'
```

```json
{ "json": { "message": "Ahoy, Ada!" } }
```

And `hello` still answers anonymously — the mark is per procedure, read from
the contract, not a gate in front of the server.

## What you now have

```
src/contract.ts   hello public, greetMe marked { user: [] }
src/auth.ts       Identity + the user scheme's resolver + the one defineHttp
src/router.ts     greetMe reads context.principal, typed
```

One file names the deployment's identities; the contract stays free of them.
When a second scheme arrives — an API key for machines, say — it is one more
key in `defineHttp`'s record, and a procedure marked with both makes the
principal a tagged union the compiler forces you to narrow
([the full recipe](/how-to/protect-a-procedure)).

## Where next

- [Split into slices](/tutorial/split-into-slices) — the next lesson: two
  contract fragments, two controllers, one composed router.
- [Protect a procedure](/how-to/protect-a-procedure) — scopes, a second
  scheme, per-procedure overrides, and the 403/401 distinction.
- [Cross-cutting concerns](/reference/http-server) — why authentication is contract
  configuration and not a middleware slot.
