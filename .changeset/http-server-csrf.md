---
"@btravstack/http-server": minor
---

`csrf` is a named option, on by default once a composed scheme reads a cookie

`csrf?: boolean` joins CORS, body limits, compression, security headers and
authentication as handler configuration on `orpc()`, `http()` and `HttpModule`.
Left unset it is **on exactly when a composed scheme reads a cookie**, which is
a fact about the graph rather than a line somebody remembered to write:
`sessionAuthenticator` contributes to a set port, and composing it is what turns
the check on.

The check is stateless — no token and no form field. A state-changing request
(`POST`/`PUT`/`PATCH`/`DELETE`) carrying cookies must be same-site by
`Sec-Fetch-Site`, or, from a client that sends no fetch metadata, carry an
`Origin` whose host matches the request's own; otherwise it is refused with
`403` before anything is dispatched and before a unit is opened. oRPC's
`GetMethodCsrfProtectionHandlerPlugin` rides the same flag, so a cross-site
`GET` at an RPC mount is refused too.

A graph that composes no cookie-reading scheme is unaffected, and `csrf: false`
turns it off.
