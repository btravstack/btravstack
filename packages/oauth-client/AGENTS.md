# AGENTS.md — @btravstack/oauth-client

The outbound half of authentication: a `TokenSource` an application depends on
to call another service **as itself or for a subject**, provided over the OAuth
2.0 client credentials grant or RFC 8693 token exchange. The root `AGENTS.md` is the authoritative spec; issue #504
is the need. A subject is a credential, never an unverified actor id; the
issuer authorizes the delegation and owns the resulting `act` claim.

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
- **`TokenRequest` is a record** — `{ audience, scope?, onBehalfOf? }` — so
  delegation does not break service-only callers. `onBehalfOf` carries a token
  and its RFC 8693 token type, plus an optional actor credential for issuers
  requiring explicit delegation. Cache and single-flight keys include every
  credential and token type, hashed so their keys retain no raw token.
  The cache is capped at 1024 entries with FIFO eviction and removes stale
  entries on access, so user credential turnover cannot retain tokens forever.
- **The issuer owns authorization and actor claims.** Sending a subject token
  without an actor credential can mean impersonation at some issuers. An
  application requiring delegation configures its issuer to produce `act`,
  and supplies the actor token when that issuer requires one. Never invent a
  subject assertion from an actor id; workers receive the subject credential
  their producer was authorized to forward. Tokens and subject identities
  never become observation details or health-check reasons.
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
- **Single flight per (audience, scope, subject and actor credentials).** Callers asking while a fetch is in
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
  every call refused. Health keys deliberately omit subject credentials: a
  replacement token's success must clear a failed obsolete credential, rather
  than leave a failure no future request can name. Before the first fetch it
  is healthy: nothing is known.
- **`TokenRefused` vs `TokenIssuerUnavailable` is decided by the error class
  and its status.** Under 500, two answers are refusals: an OAuth error body
  (`ResponseBodyError` — Hydra answers `invalid_client` as 401, an ungranted
  audience as `invalid_request` 400, an ungranted scope as `invalid_scope` 400,
  measured) and a `WWWAuthenticateChallengeError`, RFC 6749 §5.2's `401` with a
  challenge, which a conforming issuer sends for a rejected Basic credential
  and Hydra does not — so a spec serves one locally. The library throws it
  before reading the body, and §5.2 makes that answer `invalid_client`, so the
  refusal says so rather than parsing the challenge's parameters. Everything else — a fetch
  failure, a 5xx, a discovery that did not answer — is unavailability. A
  refusal carries the issuer's `error` and `error_description`, never the
  secret.
- **Discovery is OpenID Connect's, not RFC 8414's.** `openid-client`'s default
  asks `/.well-known/openid-configuration`; `algorithm: "oauth2"` would ask
  `/.well-known/oauth-authorization-server`, which the gate's Hydra answers
  `404`, as do common providers that publish only the OIDC document. The
  trigger for an option is a deployment whose issuer publishes only RFC 8414.
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

Client credentials run against the shared Hydra in `internal/test-infra`, which advertises
`client_credentials`. The per-test boundary is a CLIENT —
`createServiceClient({ audience, scope })` mints one under a UUID id — because
the caller here is a service, and what a test varies is that client's grant.
Lifetimes are measured on the fake clock; Hydra's `expires_in` is `3599` or
`3600` depending on where in a second it minted, which is why the skew tests
sit a couple of seconds either side of the boundary.

Token exchange runs against shared Keycloak 26.8.0 with native delegation
enabled (a preview feature of that issuer). Each test provisions its own realm,
subjects, and confidential client. A fixture mapper grants those subjects
`may_act` for the service account; Keycloak validates both credentials and
produces `act` itself. This is controlled test authorization, not a production
consent policy. Its HTTP readiness has a three-minute startup budget: a cold
Quarkus rebuild must finish while the CI runner shares CPU with other services.
A container that exits fails immediately with its logs. This budget belongs to
testcontainers, independently of Vitest's fixture timeout. Introspection proves active status and JOSE verifies the signed
JWT claims, since Keycloak introspection omits `act`.

Observation: see the root `AGENTS.md`, **Observability is a set port, never a flag**.
