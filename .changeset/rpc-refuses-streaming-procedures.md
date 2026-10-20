---
"@btravstack/orpc-server": minor
---

**Breaking: `orpc()` no longer serves a procedure whose OpenAPI route streams a body.** A procedure declaring `requestBodyHint: "octet-stream"` or `responseBodyHint: "octet-stream"` now answers `404` over `/rpc` before its handler runs, as an unknown procedure does. `openApiRoutes()` keeps serving it, and a streamed request body stays under `streamBodyLimit`. Declare `responseBodyHint: "octet-stream"` on a download route. An RPC answer that still carries a `ReadableStream` (in its objects, arrays, maps or sets), from a download that does not declare the hint, has the stream's cancellation started and answers `500` at once, reported to `Observers` as a defect. A locked stream cannot be cancelled and is reported as a defect of its own. It used to answer `{}`, leaving the stream unread and uncancelled. The typed RPC client still lists these procedures, so call them on their OpenAPI route.
