---
"@btravstack/contract": minor
"@btravstack/pothos": minor
---

Add `contractInputSchema` and `contractOutputSchema` under
`@btravstack/contract/orpc`. They preserve the original Zod schema and its
client/server codec types, and reject missing, non-Zod or chained schemas at
composition. The optional entry requires Zod and oRPC contract peers.

Pothos reuses the input accessor through its existing `contractInput` export;
install its new `@btravstack/contract` peer alongside the plugin.
