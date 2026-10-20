---
"@btravstack/orpc-server": minor
---

**Breaking: `orpc()` no longer serves a procedure whose OpenAPI route streams a body.** A procedure declaring `requestBodyHint: "octet-stream"` or `responseBodyHint: "octet-stream"` now answers `404` over `/rpc` before its handler runs, as an unknown procedure does. `openApiRoutes()` keeps serving it, and a streamed request body stays under `streamBodyLimit`. Declare `responseBodyHint: "octet-stream"` on a download route. An RPC answer that still carries a `ReadableStream`, from a download that does not declare the hint, has the stream cancelled and answers `500`, reported to `Observers` as a defect. It used to answer `{}`, leaving the stream unread and uncancelled. The typed RPC client still lists these procedures, so call them on their OpenAPI route.
