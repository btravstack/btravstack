---
"@btravstack/orpc-server": patch
---

Load against current oRPC betas. `@orpc/contract@2.0.0-beta.46` replaced
`getAsyncIteratorObjectSchemaDetails` with `getAsyncIteratorObjectSchemasDetails`,
so every entry point failed to import under the `^2.0.0-beta.28` peer range a
package manager resolved to the newest beta (#746). The answerer now uses the
new export, and its `@orpc/*` peers start at `2.0.0-beta.46`.

That floor changes one wire status: oRPC answers an error code outside its
standard map with `DEFAULT_ERROR_STATUS`, which is `400` since `beta.45` and was
`500`. A custom refusal such as `INVALID_QUANTITY` now reaches the RPC wire as
a `400`, and an undeclared custom code is no longer reported to `Observers` as
a defect.
