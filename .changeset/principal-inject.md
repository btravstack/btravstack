---
"@btravstack/http-server": minor
---

`jwtAuthenticator` and `oidc()` take an `inject` record beside `principal`,
which now receives the injected services as its second argument —
`principal(claims, { trusted })` — so a claim check can read configuration or
a port, such as an allow-list of trusted delegation subjects. Each injected port
joins the scheme's needs.
