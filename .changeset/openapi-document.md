---
"@btravstack/http-server": minor
---

Emit an OpenAPI document from a contract, with the security marker folded in.

```ts
import { openApiDocument } from "@btravstack/http-server/openapi";

const document = await openApiDocument(contract, {
  base: { info: { title: "Order API", version: "1.0.0" } },
  securitySchemes: { user: { type: "http", scheme: "bearer" } },
});
```

`@btravstack/contract` has modelled OpenAPI's security semantics exactly for a
while — AND versus OR, scopes, nearest-mark-wins — and produced no document, so
the model reached TypeScript and nothing else. This closes that: Swagger UI,
client codegen for non-TypeScript consumers and API-gateway integration all
consume a document, not a `.ts` file.

**It is a fold, not a translation.** `Requirement` is
`Readonly<Record<string, readonly string[]>>` — byte-identical to OpenAPI's
`SecurityRequirementObject`, keys within one object AND, separate objects OR.
The emitted `security` is the marker's own value, reinterpreted nowhere.

A document from this stack carries **OR and never AND**, because AND cannot be
expressed a layer earlier: `@btravstack/contract` refuses the multi-key
requirement OpenAPI reads as AND, since this package would run it as OR.

`securitySchemes` is yours to supply, because the contract deliberately says
WHICH schemes protect a route and never what a scheme IS — the same split
`defineHttp({ authenticators })` makes, one layer out.

**Nothing serves it**, and that is a decision rather than an omission: a Swagger
UI bundle inside a transport package would be a runtime dependency for every
consumer, including those who never ask for a document. An application serves
the value from a route of its own; `examples/order-api/src/openapi.ts` is the
recipe, and its spec asserts the real document — including `/orders/export`,
which carries OR across two schemes and a scope straight out of the application's
own contract.

`@orpc/openapi` and `@orpc/json-schema` are **optional peers behind the
`/openapi` subpath**, so a consumer that never imports it installs neither.
