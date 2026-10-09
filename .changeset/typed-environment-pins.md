---
"@btravstack/config": minor
"@btravstack/http-server": minor
"@btravstack/outbox": minor
---

A variable a starter option can pin is now required in a boot's `env` unless the call pins it, and absent from it when it does: `jwtAuthenticator`, `oidc()`, `sessionAuthenticator`, `sessionCodec` and `outbox` infer each pinnable option's type, and their needs say `HTTP_JWT_ISSUER` (and the like) is required when the option is left out, optional when its value may be `undefined`, and not read when it is given. `Unpinned<X, V>` and `MaybePinned<X, V>` are the config helpers that spell it.
