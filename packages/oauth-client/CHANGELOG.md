# @btravstack/oauth-client

## 0.43.0

### Patch Changes

- @btravstack/config@0.43.0
  - @btravstack/core@0.43.0
  - @btravstack/di@0.43.0

## 0.42.0

### Patch Changes

- @btravstack/config@0.42.0
  - @btravstack/core@0.42.0
  - @btravstack/di@0.42.0

## 0.41.0

### Patch Changes

- @btravstack/config@0.41.0
  - @btravstack/core@0.41.0
  - @btravstack/di@0.41.0

## 0.40.0

### Patch Changes

- @btravstack/config@0.40.0
  - @btravstack/core@0.40.0
  - @btravstack/di@0.40.0

## 0.39.1

### Patch Changes

- Updated dependencies [1c3e10b]
  - @btravstack/core@0.39.1
  - @btravstack/config@0.39.1
  - @btravstack/di@0.39.1

## 0.39.0

### Minor Changes

- 6117825: Add an application-policy-bound outbound HTTPS client with exact approved origins,
  connection-time destination checks, verified TLS, refused redirects and encoding,
  bounded response bytes, whole-operation deadlines and cancellation. OAuth can use
  the same composed fetch boundary for discovery and credential-bearing token calls.

### Patch Changes

- @btravstack/config@0.39.0
  - @btravstack/core@0.39.0
  - @btravstack/di@0.39.0

## 0.38.0

### Patch Changes

- @btravstack/config@0.38.0
  - @btravstack/core@0.38.0
  - @btravstack/di@0.38.0

## 0.37.0

### Patch Changes

- @btravstack/config@0.37.0
  - @btravstack/core@0.37.0
  - @btravstack/di@0.37.0

## 0.36.0

### Patch Changes

- @btravstack/config@0.36.0
  - @btravstack/core@0.36.0
  - @btravstack/di@0.36.0

## 0.35.1

### Patch Changes

- @btravstack/config@0.35.1
  - @btravstack/core@0.35.1
  - @btravstack/di@0.35.1

## 0.35.0

### Patch Changes

- @btravstack/config@0.35.0
  - @btravstack/core@0.35.0
  - @btravstack/di@0.35.0

## 0.34.0

### Patch Changes

- @btravstack/config@0.34.0
  - @btravstack/core@0.34.0
  - @btravstack/di@0.34.0

## 0.33.0

### Patch Changes

- Updated dependencies [f5ae34d]
- Updated dependencies [f690c1c]
  - @btravstack/di@0.33.0
  - @btravstack/core@0.33.0
  - @btravstack/config@0.33.0

## 0.32.0

### Patch Changes

- Updated dependencies [edbd7a3]
  - @btravstack/core@0.32.0
  - @btravstack/config@0.32.0
  - @btravstack/di@0.32.0

## 0.31.0

### Patch Changes

- Updated dependencies [9ce7852]
  - @btravstack/config@0.31.0
  - @btravstack/core@0.31.0
  - @btravstack/di@0.31.0

## 0.30.1

### Patch Changes

- @btravstack/config@0.30.1
  - @btravstack/core@0.30.1
  - @btravstack/di@0.30.1

## 0.30.0

### Minor Changes

- 8d1c2a3: Support RFC 8693 token exchange through an optional subject and actor credential on TokenRequest. Cache and single-flight keys isolate every credential and token type with bounded FIFO retention; issuer refusals and outages retain their typed errors. Verify delegation against a real Keycloak issuer.

  Snapshot the complete request at entry so caller mutation cannot change the grant associated with a credential's cache key. Health remains keyed by audience and scope and follows the newest-started fetch, so replacing a refused subject credential restores the component even when older responses arrive later. Generation bookkeeping is retained only for pending fetches.

### Patch Changes

- Updated dependencies [a590301]
  - @btravstack/core@0.30.0
  - @btravstack/config@0.30.0
  - @btravstack/di@0.30.0

## 0.29.0

### Minor Changes

- 1d2ac78: New package: `@btravstack/oauth-client`, the client credentials half of an
  outbound token source. `oauthClient()` provides a `TokenSource` port over an
  OAuth 2.0 authorization server — configured from `OAUTH_ISSUER`,
  `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET`, discovered lazily, a token kept
  per audience and scope until a minute before it expires, one fetch shared by
  concurrent callers, every fetch reported to `Observers` and an `oauth-client`
  health check. A refusal is a typed `TokenRefused` carrying the issuer's
  `error` code, an outage a `TokenIssuerUnavailable`. `staticTokenSource` is
  the in-process adapter a spec overrides with.

  `@btravstack/config` now exports `cleartext` and `cleartextRefused`, the rule
  `oidc()` and `jwtAuthenticator` refuse a cleartext issuer or JWKS by, moved
  out of `@btravstack/http-server` so a package that only calls out can apply it.

  The rule also refuses any scheme other than `https:` and `http:`, opt-in or not: a `file:` issuer or JWKS URL used to pass boot and fail on first use, and is now a `ConfigInvalid` at boot for `oidc()`, `jwtAuthenticator` and `oauthClient()` alike.

### Patch Changes

- Updated dependencies [1d2ac78]
- Updated dependencies [5bf7ace]
  - @btravstack/config@0.29.0
  - @btravstack/core@0.29.0
  - @btravstack/di@0.29.0
