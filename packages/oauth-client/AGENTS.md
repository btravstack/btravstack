# AGENTS.md — @btravstack/oauth-client

The outbound half of authentication: a `TokenSource` an application depends on
to call another service **as itself**, provided over the OAuth 2.0 client
credentials grant. The root `AGENTS.md` is the authoritative spec; issue #504
is the need. This package is its client-credentials half only — **token
exchange on behalf of an actor (RFC 8693) is deferred**, and why is in
`docs/explanation/deferred-decisions.md`.

## Public surface

The exports are `src/index.ts`, each with its TSDoc; `docs/reference/oauth-client.md`
is the reader's page and `docs/how-to/call-another-service-as-itself.md` the
recipe.

## Decisions

- **One port, not the cache/mailer pair.** Those packages carry two ports so
  the observing wrapper can sit between an adapter and the port an
  application reads. Here what is observed is a FETCH, which only the real
  adapter makes — a token served from memory reports nothing, by the root's
  "a success writes no line" rule, and a static token source has nothing to
  report. With no wrapper there is nothing for a second port to separate, so
  `oauthClient()` provides `TokenSource` directly and a spec overrides that
  same port with `staticTokenSource`.
- **`TokenRequest` is a record** — `{ audience, scope? }` — so the actor of a
  token exchange joins it as one more optional field (`onBehalfOf`) without
  breaking a caller. The cache key is the record's fields, which that field
  would extend.
- **`AccessToken` is `{ bearer }`, with no expiry.** Keeping a token until
  shortly before it expires is the source's job; a caller holding the expiry
  is a caller about to cache it a second time. A record, so a field can be
  added later without breaking anyone.
- **The skew is a minute, capped at half the lifetime.** A token must outlive
  the request it rides: the callee's queue, a retry, and a clock that
  disagrees with this one. A minute covers an ingress's default response
  timeout; the cap keeps a token minted for two minutes reusable rather than
  fetched on every call. A response without `expires_in` is never reused —
  `(expires_in ?? 0)` makes it already stale, with no branch of its own.
- **Single flight per (audience, scope).** Callers asking while a fetch is in
  flight receive THAT `AsyncResult` — unthrown's is a promise underneath, so
  any number of consumers may await one. It leaves the in-flight map when it
  settles, and only an `Ok` enters the cache: a failure is asked again by the
  next caller, which is what an outage that ends needs.
- **Discovery is lazy, and that is the IdP-outage-at-deploy answer.**
  `oidc()` discovers at boot because a login needs the provider for every
  request it serves. A service that calls out needs a token only on the paths
  that call, and those fail with `TokenIssuerUnavailable` whatever the boot
  proved, because tokens expire hourly and the issuer has to be there each
  time. Failing the boot on discovery would turn an issuer blip into a
  crashlooping rollout of a process whose other routes work. Configuration is
  still validated at boot — a missing variable or a cleartext issuer is a
  `ConfigInvalid` and exit `78` — because those are the deployment's mistakes,
  not the issuer's weather. A failed discovery is not memoised either.
- **The health check reports the last fetch per (audience, scope).** It fails
  while any key's most recent fetch failed, naming the audience and the
  issuer's code, and recovers when that key next fetches. A probe of the
  issuer was declined: it proves reachability only, and the failure an
  operator meets most — a rotated secret — leaves the issuer reachable and
  every call refused. Before the first fetch it is healthy: nothing is known.
- **`TokenRefused` vs `TokenIssuerUnavailable` is decided by
  `ResponseBodyError` and its status.** An OAuth error body under 500 is a
  refusal (Hydra answers `invalid_client` as 401, an ungranted audience as
  `invalid_request` 400, an ungranted scope as `invalid_scope` 400 —
  measured); everything else — a fetch failure, a 5xx, a discovery that did
  not answer — is unavailability. A refusal carries the issuer's `error` and
  `error_description`, never the secret.
- **The cleartext rule is `@btravstack/config`'s `cleartext`**, moved out of
  `@btravstack/http-server` for this package rather than copied: a client must
  not depend on the serving half. Loopback is accepted as it stands, which is
  how the specs talk to the gate's `http://localhost:4444/` Hydra.
- **`openid-client` is a REQUIRED peer at the root entry**, not an optional
  one behind a subpath: the package is that adapter plus a port, and a
  consumer who wants only the port and the static source is not a case worth
  a second entry point. It is also why the floor is Node `>=22.12`:
  `openid-client` is ESM-only, so the CommonJS build's `require` of it needs
  `require(esm)` — the consumer check's floor run refused `>=22` with
  `ERR_REQUIRE_ESM`. `@btravstack/http-server` pays the same floor for the same
  reason.
- **No variable prefix option.** `jwtAuthenticator` and `oidc()` take
  `variablePrefix` because a deployment plausibly trusts two issuers. A
  service authenticating as two different clients is not yet a case; when it
  is, the option is the shape to copy.

## Deliberately not here

- **Token exchange (RFC 8693).** Deferred; see above.
- **A header helper for an oRPC client.** It would return a `Promise` — oRPC's
  `headers` option is `async` — and the root's thesis #6 lists the only
  exceptions. The how-to shows the three lines at the call site, where the
  `Result` is unwrapped by the code that knows what a refusal means for it.
- **Retries.** A failed fetch is a modeled error, and the caller's transport
  owns redelivery, as with `MailNotSent`.
- **Private-key client authentication, mTLS, DPoP.** `client_secret_basic`
  is what the gate's issuer and most deployments use; another method is an
  option when a deployment needs it.

## Testing

Against the shared Hydra in `internal/test-infra`, which advertises
`client_credentials`. The per-test boundary is a CLIENT —
`createServiceClient({ audience, scope })` mints one under a UUID id — because
the caller here is a service, and what a test varies is that client's grant.
Lifetimes are measured on the fake clock; Hydra's `expires_in` is `3599` or
`3600` depending on where in a second it minted, which is why the skew tests
sit a couple of seconds either side of the boundary.

Observation: see the root `AGENTS.md`, **Observability is a set port, never a flag**.
