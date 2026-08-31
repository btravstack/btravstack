---
"@btravstack/http-server": minor
---

`openApiDocument` answers through the Result channel, with options typed by
the library.

It returned a bare `Promise<OpenApiDocument>` — the one async surface in the
family outside the documented exceptions — so a generator rejection escaped
as a raw rejection with no defect channel. It now returns
`AsyncResult<OpenApiDocument, never>`: async, and cannot fail, with a
generator fault arriving as a defect. Extraction is `.get()`:

```ts
const document = (await openApiDocument(contract, options)).get();
```

`base` and `securitySchemes` were `Record<string, unknown>` bags — the
untyped-passthrough shape this family bans, under which a key the generator
ignores was silently inert. `base` is now `Partial<OpenApiDocument>` and
`securitySchemes` the new `OpenApiSecuritySchemes` export, the document's own
`components.securitySchemes` shape, so a wrong key is a type error.
