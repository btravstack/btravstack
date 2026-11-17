---
"@btravstack/orpc-server": patch
---

Load against current oRPC betas. `@orpc/contract@2.0.0-beta.46` replaced
`getAsyncIteratorObjectSchemaDetails` with `getAsyncIteratorObjectSchemasDetails`,
so every entry point failed to import under the `^2.0.0-beta.28` peer range a
package manager resolved to the newest beta (#746). The answerer now uses the
new export, and its `@orpc/*` peers start at `2.0.0-beta.46`.
