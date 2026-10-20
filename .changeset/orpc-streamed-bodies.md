---
"@btravstack/http-server": minor
"@btravstack/orpc-server": minor
---

**Breaking: `HttpConfig` gains a required `streamBodyLimit` field.** A graph that provides `HttpConfig` by hand must add it; one bound by `HttpModule`, `GraphqlModule` or `http()` needs no change. `OrpcOptions.plugins` is now `StandardHandlerPlugin[]` from `@orpc/server/standard`, since oRPC removed adapter plugins in `2.0.0-beta.37`.

Stream a body a route reads as a stream, under its own limit. An OpenAPI route declaring `openapi({ inputStructure: "detailed", requestBodyHint: "octet-stream" })` gets `input.body` as a `ReadableStream` while the client is still sending, bounded by the new `streamBodyLimit` option (`HTTP_STREAM_BODY_LIMIT`, default 1 GiB; `false` or `0` is unbounded) instead of `bodyLimit`. A declared `content-length` over the limit answers `413` before reading; a body that passes it errors its stream with `PAYLOAD_TOO_LARGE` and the request answers `413`, whatever the handler made of the error. Every other body keeps `bodyLimit` (`HTTP_BODY_LIMIT`) exactly as before, measured after request decompression. The catalog moves to oRPC `2.0.0-beta.44`.
