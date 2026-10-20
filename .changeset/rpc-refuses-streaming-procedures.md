---
"@btravstack/orpc-server": minor
---

**Breaking: `orpc()` no longer serves a procedure that streams a body.** A procedure declaring `requestBodyHint: "octet-stream"` or `responseBodyHint: "octet-stream"`, or whose output schema takes a `ReadableStream` as its answer or as a detailed answer's `body`, now answers `404` over `/rpc` before its handler runs, as an unknown procedure does; `openApiRoutes()` keeps serving it, under `streamBodyLimit`. A download over `/rpc` used to open its stream and answer `{}` for it, leaving the stream unread and uncancelled. The typed RPC client still lists such procedures; call them on their OpenAPI route.
