---
"@btravstack/http-server": minor
"@btravstack/config": minor
---

`Config.list` reads a comma-separated variable, and
`@btravstack/http-server/session` binds one

`Config.list(variable, { default?, min? })` answers `readonly string[]`: entries
are trimmed, empty ones dropped, and a list shorter than `min` (default `1`) is
named against the variable, by the same rule a pin and a default take.

`sessionCodec({ keys?, ttlSec? })`, behind `@btravstack/http-server/session`
with `jose` as an optional peer, is the storage-free half of a session cookie:
`seal` turns a principal into a `dir` + `A256GCM` JWE stamped with its own
lifetime, `unseal` turns a cookie back into a session or into nothing. Keys come
from `HTTP_SESSION_KEYS` — the first seals, every one unseals, so rotation is
prepend, deploy, drop.
