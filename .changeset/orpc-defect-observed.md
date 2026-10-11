---
"@btravstack/orpc-server": minor
---

`orpc()` and the OpenAPI routes report a defect to `Observers` before oRPC answers `500`, as an `orpc` / `defect` operation carrying the cause and the procedure's path. The client still sees only `INTERNAL_SERVER_ERROR`, and an error the contract declares is not reported. Both answerers now read `Observers`, which `httpServer()` already provides, so no root changes.
