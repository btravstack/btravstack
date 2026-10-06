---
"@btravstack/http-server": minor
---

**New: `headersTimeoutMs` and `requestTimeoutMs`, read from `HTTP_HEADERS_TIMEOUT_MS` and `HTTP_REQUEST_TIMEOUT_MS`.** The listener never set either, so Node's defaults applied silently and nothing tested them. Both are now stated and pinnable, like `bodyLimit`.

A client that is still sending its headers past the first bound, or its whole request past the second, gets `408 Request Timeout` and a closed socket. The defaults are Node's own (60 s and 300 s), so nothing changes for a deployment that sets neither. Each must be at least `1`, because `0` would mean no bound.

The request bound covers what the client sends, never the response, so a long-lived event stream is not cut. A headers bound set above the request bound is held to the request bound. Node would otherwise refuse that pair at boot.

Node only checks these bounds periodically. The check now runs at least as often as the tighter bound, so a short bound fires on time instead of up to 30 s late.
