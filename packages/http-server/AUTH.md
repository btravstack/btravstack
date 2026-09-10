# `@btravstack/http-server` — the authentication surface

The authentication half of this package's public surface. It governs
`auth.ts`, `principal.ts`, `define-http.ts` and the `@btravstack/contract`
marker; **read it before changing any of those.** The rest of the surface —
the router, the controller, `HttpModule`, the runtime and the internal seam —
is in `packages/http-server/CLAUDE.md`, and the repository-wide theses are in
the root `CLAUDE.md`.

The two rules this half exists to state, before the detail:

- **The contract says WHICH SCHEMES protect a route, and which scopes each
  must grant; the application's `defineHttp({ authenticators })` says WHAT
  each scheme resolves to.**
- **An unmarked procedure is public, and nothing fails if the marker is
  forgotten.** The contract is the only statement of intent there is. Do not
  describe an unmarked procedure as checked.

## Surface

- **`@btravstack/contract`'s marker, in the types and at runtime.**
  `authenticated(...requirements)(node)` brands a contract node
  `Authenticated<T, R>` — an
  intersection with a `unique symbol` key holding the exact `Requirements`, no
  runtime property
  and **no principal type** — and `Implementation<C, Schemes>` branches on
  `IsMarked<C>`. A marked **leaf** gets
  `{ readonly principal: Principal<SchemesOf<R>, Schemes> }` in
  `ProcedureImplementer`'s **second** type parameter (`TInjectedContext`), so
  the principal arrives on `opts.context.principal`: **oRPC's own context
  channel**, not a second handler parameter this package invents and not a
  wrapper around `.result()`. A marked **record** pushes its requirements onto
  each child that carries none (`Inherit<T, R>`), so a marked fragment protects
  every procedure beneath it while a procedure's own mark **replaces** that
  default for itself — **nearest mark wins**, which is OpenAPI's own rule and
  what `Effective<C, R>` spells. The record arm walks
  `Exclude<keyof C, PrincipalKey>` so the
  phantom key never becomes a procedure key. An unmarked leaf keeps today's
  spelling, `object`, exactly — which is what makes the negative gate
  meaningful, since `DefaultInitialContext` is an empty interface rather than
  an index signature. What makes the type true at runtime is
  `principalMiddleware`, below.
- **`Principal<S, Schemes>` and `SchemesOf<R>`** (`principal.ts`) — what a
  leaf's handler actually reads, from the scheme NAMES its effective
  requirements union to. **One scheme is the identity bare**, byte-for-byte
  what applications wrote before this feature, so the common case pays nothing
  for it; **several schemes are a discriminated union**,
  `{ scheme, identity }` per arm, narrowed with an exhaustive `switch` whose
  missing arm is a compile error; **no scheme is `never`**, so a public leaf's
  `principal` cannot be read at all. `SchemesOf<R>` maps over the tuple and
  then indexes — `{ [I in keyof R]: keyof R[I] & string }[number]` — and is
  **not** `keyof R[number]`, which is the INTERSECTION of each requirement's
  keys and collapses to `never` the moment two requirements name different
  schemes: exactly the multi-scheme case, and it failed silently (measured).
  `IsUnion<T>` is the standard distribute-then-compare-back test; do not
  "simplify" it to `T extends U`. All seven arms are pinned by
  `principal.test-d.ts` — the last of them asserting `SchemesOf` in **both**
  directions, since a one-way assignment out of a collapsed `never` passes and
  is how the first cut of that test missed a broken `SchemesOf` entirely.
- **`HttpAuthenticator<P, Scope>()({ inject: { name: Dep }, sync })` — or
  `({ inject: {}, sync })`, the common shape, since an authenticator reading
  only headers declares no dependencies, or `({ inject, make })` where building
  the scheme can FAIL — plus `authenticatorPort(scheme)`,
  `Unauthenticated`, `granted(identity, scopes)`, `Grant<P, Scope>`,
  `Granted<P, Scope>`, `AuthenticatorService<P, Scope>`**
  (`auth.ts`) — how one **security scheme** is implemented.
  `sync` and `make` are the pair di's `Provider` has, and naming both is
  refused: `make` answers `AsyncResult<AuthenticatorService<P, Scope>, E>` and
  its `E` becomes the description's, so a scheme whose CONSTRUCTION can fail —
  one reading its issuer from the environment — fails the boot with a typed
  error rather than constructing happily and refusing every caller.
  `AuthenticatorService<P, Scope>` is
  `(headers: IncomingHttpHeaders) => AsyncResult<Granted<P, Scope>, Unauthenticated>` —
  **headers, not the request**: an authenticator has no business reading a
  body, and the narrower argument is what keeps it testable without a socket.
  `Granted<P, Scope>` is `P` when `Scope` is `never` — a scheme with no scope
  vocabulary returns the identity bare, byte-for-byte what applications wrote
  before — and `Grant<P, Scope>` when it has one, so
  the granted list is checked against the declared vocabulary at the
  authenticator rather than compared as loose strings at the endpoint.
  **`Grant` is BRANDED with a module-private `unique symbol` and `granted()`
  is the only thing that mints one**, which makes the helper mandatory rather
  than advisory: a hand-built `{ identity, scopes }` does not type-check as the
  scoped answer. The type parameter is erased at runtime, so a structural test
  is the alternative and is unsound — `"scopes" in answer` reads a
  claims-shaped BARE identity (`{ userId, tenantId, scopes }`, the ordinary JWT
  case) as the scoped one, injects its absent `identity`, and hands every
  handler on that route `undefined`. `Symbol.for` rather than `Symbol()`: two
  copies of this package would otherwise read each other's grants as bare.
  `Scope` is not inferred from the vocabulary on `granted` itself — an empty
  grant would collapse it to `never` and take the return type back to the bare
  arm — so the array states it and the assignment checks it.
  `authenticatorPort(scheme)` mints
  ``Port(`HttpAuthenticator:${scheme}`)<AuthenticatorService<unknown>>`` — the
  move `AmqpHandler(contract, key)` makes, with the scheme name on the port
  **id**, so `HttpAuthenticator:user` and `HttpAuthenticator:service` are
  different types and a scheme with nobody behind it is di's own unmet need
  naming the port. It is **memoised** in a module-level `Map`: `defineHttp`
  asks for a port when it binds an authenticator and `routerFor` asks again for
  every scheme its contract names, and two `Port(id)` calls under one id are
  di's duplicate-id warning. The service type is **erased to `unknown`**
  (`Granted<unknown, never>` is `unknown`, so it admits the bare and the scoped
  answer alike) because di identifies a port by id; the principal and scope
  types ride the description `HttpAuthenticator` hands back —
  `{ deps, options, principal: P, scope: Scope, needs: N }` — which is what
  `defineHttp` binds and reads the registry off.
  Both type arguments are explicit rather than inferred from `sync`: inference
  through a returned function's `AsyncResult` is exactly where a principal
  silently widens to `unknown`.

  **A principal is now a PORT too.** `principalPort(scheme)` mints
  ``Port(`HttpPrincipal:${scheme}`)<P>`` on the **same memoising map**, for the
  same reason: `defineHttp` mints one per declared scheme and a unit module
  depends on it, which is the designed two-call pattern rather than the
  duplicate declaration di's warning exists to catch. It is what lets a
  per-request module name the caller it was opened for in its own `needs` —
  the scheme name is on the port **id**, so `HttpPrincipal:user` and
  `HttpPrincipal:service` are different types and a module needing one is met
  only by a unit opened under that scheme. Exported for the same consumer
  `authenticatorPort` is: a test seeding one scheme's principal by hand.

  **The empty parens are TypeScript's, not a style choice, and the alternative
  was measured.** Type arguments are all-or-nothing per call: naming `P` and
  `Scope` on a single-call form means `D` — the `inject` record — stops being
  inferred and falls back to its constraint, so `sync`'s services parameter
  degrades from `{ verify: JwtVerifier's service }` to an index signature and
  every key's type is lost (verified with a probe against this package's own
  `tsconfig.test-d.json`). Currying is what lets `P` and `Scope` be stated
  while `D` is still inferred. The one shape that removes the parens is a
  value-level type witness — `principal: type<Identity>()`, the way oRPC
  carries a schema-less type — which compiles, and trades a syntactic oddity
  for a phantom argument in every authenticator plus an `@orpc/contract`
  import in packages that have no other reason to hold one. Not taken, and
  not to be re-attempted without a third option. The **scheme name is not stated here** — it is
  the key this authenticator sits under in `defineHttp({ authenticators })`, so
  it is written once. `Unauthenticated` is a `TaggedError` with an
  **empty payload**: the starter surfaces no reason — a refused caller gets an
  `UNAUTHORIZED` and oRPC's default message — so a field here would be
  write-only. An authenticator that wants to record why logs it before
  returning. Forwarding a reason would put "no such user" versus "bad
  signature" in a 401 body by default.

- **`apiKeyAuthenticator<P>()({ header?, keys })` → `Authenticator<P, ScopesOf<Keys>, never>`**
  (`api-key.ts`, on the main entry point — it has no peer to be optional
  about). Each key carries the principal presenting it makes, and optionally
  what it grants. Three things it does that a hand-written one usually does
  not, each with a test:
  - **It compares SHA-256 digests, not strings.** `===` on a secret leaks its
    prefix through timing, and `timingSafeEqual` refuses two buffers of
    different lengths — which would leak the key's length instead. Hashing
    first makes every comparison 32 bytes wide whatever was presented.
  - **It checks every configured key with no early return.** A loop that
    `break`s on the first match takes longer for a key configured late, which
    is a slower oracle but an oracle.
  - **A missing header takes the same path as a wrong key**, so "no credential"
    and "bad credential" are not distinguishable by timing either.

  **The vocabulary is INFERRED from the keys, never declared twice.** It is the
  union of what the keys grant, so a scheme cannot advertise a scope no key can
  issue — which would pass the contract's own `ScopeGate` and then refuse every
  caller with a permanent 403, the failure that gate exists to catch one layer
  up. The scheme is scoped when any key grants something, decided once at
  composition so the answer's SHAPE cannot vary per key: a scoped scheme whose
  matched key declared nothing answers an empty grant, never a bare identity.
  `jwtAuthenticator` follows the same rule over its single `scopes` array.

  The curried `<P>()(…)` shape is `HttpAuthenticator`'s own, and for the same
  reason: the principal is stated and the rest is inferred.

  The keys come from the caller — an `Env`-bound config field, a secret store —
  because a key list in the image is a key list in the repository.
  `examples/order-api`'s `serviceAuth` is this, not a stand-in.

- **`jwtAuthenticator<P>()({ jwks?, issuer?, audience?, algorithms?, clockToleranceSec?, header?, principal, scopes? })`
  → `Authenticator<P, Scopes[number], Env, ConfigInvalid>`, and `DEFAULT_ALGORITHMS`** — from
  **`@btravstack/http-server/jwt`**, with `jose` an OPTIONAL peer: a graph that
  never imports the subpath installs nothing. What it owns is the part where
  writing it per application is how CVEs happen:
  - **JWKS fetch, cache and rotation** — `jose`'s `createRemoteJWKSet` fetches
    on demand and refetches when a token names an unseen `kid`, rate-limited so
    unknown `kid`s cannot be turned into a request amplifier against the issuer.
  - **An algorithm allowlist that excludes HMAC.** `DEFAULT_ALGORITHMS` is
    `RS*`/`ES*` only. A JWKS publishes PUBLIC keys, so accepting `HS256` beside
    them is the **algorithm-confusion** attack — an attacker signs with the
    published public key as the shared secret. There is a test that mints
    exactly that token and is refused.
  - **`iss`, `aud` and `exp` are REQUIRED to be present**, through jose's
    `requiredClaims` — because jose validates `exp` only when it IS present, so
    without that a signed token omitting it authenticates and never expires.
    `nbf` is honoured when present and deliberately not required: real issuers
    often omit it, and requiring it would refuse legitimate tokens.
    `clockToleranceSec` defaults to `0`, so leeway is opt-in. `aud` is the one
    whose absence lets a token minted for a sibling service be replayed here.
  - **One refusal for every failure.** A bad signature, an expired token and an
    audience mismatch are indistinguishable from outside — `Unauthenticated`
    carries no reason, so the endpoint is not an oracle for which of them the
    attacker got wrong.

  **`jwks`, `issuer` and `audience` are OPTIONAL, and bound from
  `HTTP_JWT_JWKS_URI`, `HTTP_JWT_ISSUER` and `HTTP_JWT_AUDIENCE` when they are
  not supplied.** The option is what a test pins, the variable what a
  deployment sets — `http({ port })` against `PORT`, one layer down — and the
  rule that decides it is the repository's own: something belongs in the
  environment when it varies by deployment, not when it is
  "configuration-shaped". All three do. Staging and production authenticate
  against different issuers, a JWKS endpoint moves, and the audience is the
  deployment's own name; none of it belongs in the image. A variable nobody
  pinned and nobody set is a `ConfigInvalid` naming it, at startup, with every
  offending variable in one message. The rest stay options: `algorithms` and
  `clockToleranceSec` because a value whose silent change is a security
  regression is not an environment's to change, `header`/`principal`/`scopes`
  because an environment carries no functions and no arrays.

  **One JWT scheme per process**, which is why the prefix is `HTTP_JWT_` and
  not `HTTP_JWT_<SCHEME>_`. Two schemes reading the same three variables are
  one scheme; a genuinely second issuer pins all three explicitly, exactly as a
  test does. The `string | readonly string[]` forms of `issuer` and `audience`
  are gone with that decision: an environment carries one string, and a second
  accepted issuer is a second authenticator.

  **The piece is a `make` arm.** Reading the environment can fail, so the
  scheme's provider carries `ConfigInvalid` on its error channel and a
  misconfigured deployment fails the BOOT — `runMain`'s `78`, naming the
  variables — instead of constructing happily and refusing every caller with a
  401 that carries no reason. `Config.parse` is what it runs, the step
  `Config.provider` performs, lifted so both have one home. Its `inject` is
  `{ env: Env }`, and a root composing this scheme writes no `needs` line for
  it: `HttpModule` carries `Env` for every provider in the root, its schemes
  included, the same way it already carries the starter's own. A scheme owing any OTHER unmet port is
  still refused at the `HttpModule` call.

  **`jwks` is a `Config.url` field**, not a `Config.string` one:
  `createRemoteJWKSet` takes a `URL`, `new URL` throws, and a throw inside the
  piece's `make` is a `Defect` with no variable named. A scheme-less
  `HTTP_JWT_JWKS_URI` is the likeliest of the three slips, so it is the one that
  most needed to arrive as the `ConfigInvalid` this promises.

  **The `/jwt` subpath needs Node ≥22.12 under CommonJS.** `jose` is ESM-only,
  so the CJS build's `require("jose")` depends on `require(esm)`, which Node
  enables by default from 22.12. ESM consumers are unaffected on any Node 22, and
  so is every consumer that never imports the subpath — which is why this is
  stated here rather than paid for by raising the package's own `engines` floor,
  a breaking change for the many to serve the few.

  `principal(claims)` is the application's, and answering `undefined` is a
  **refusal** rather than a principal of `undefined`: no standard claim carries
  a tenant, and this is where one enters. `scopes` is the vocabulary, and the
  grant is its **intersection** with the token's `scope` (space-delimited, RFC 8693) or `scp` (an array — Entra, Okta); a token claiming a scope the scheme
  does not know grants nothing extra. Nothing new checks them: the grant goes
  through `granted()` and the existing walk produces the 403.

- **`sessionAuthenticator<P>()({ cookie?, scopes?, principal? })`
  → `Authenticator<P, Scopes[number], SessionCodec, never>`** — from
  **`@btravstack/http-server/session`**, beside `sessionCodec` and behind the
  same optional `jose` peer. The third scheme, and the only one whose
  credential this stack seals itself: it reads the `cookie` header, hands the
  named cookie to `SessionCodec`'s `unseal`, and answers what the session
  carries. `requires: [{ session: [] }]` on a fragment route and
  `authenticated({ session: [] })` on a procedure need nothing new — a scheme
  is a scheme.

  **It injects the codec's PORT rather than holding keys.** Its needs channel
  is `SessionCodec`, so a root composing the scheme without `sessionCodec()` is
  di's own unmet need naming `SessionCodec` — refused at the `HttpModule`
  call rather than at the first request — and the codec that reads a cookie is
  by construction the one that sealed it, key rotation included.

  **The cookie header is parsed here, by hand, and by name.** `node:http`
  delivers every cookie as ONE string, so the scheme splits on `;` and matches
  the name EXACTLY — `__Host-session-theme` is not `__Host-session` — splits
  the value on the FIRST `=` only, and takes the FIRST of a repeated name,
  which is the order a browser sends them in (most specific first), so a
  duplicate cannot shadow the session. Six lines and no dependency.

  **`__Host-session` is the default and there is no `secure` knob.**
  `__Host-` is a prefix the BROWSER enforces — `Secure`, `Path=/`, no
  `Domain` — so a sibling host cannot write the cookie and a downgrade to
  plain HTTP cannot carry it. An option that turned that off would be an
  option for shipping a session cookie insecurely; `cookie` renames it, and
  renaming it away from the prefix is a visible act.

  **The lifetime is the codec's, not the scheme's**, and there is no sliding
  re-seal: a scheme has HEADERS, not a response, so it has nowhere to put a
  `Set-Cookie`. The session ends when `sessionCodec`'s `ttlSec` says it does,
  and the browser logs in again. Rotation is the codec's too — prepend,
  deploy, drop.

  **The vocabulary is decided once at composition**, `apiKeyAuthenticator`'s
  own rule: `scopes` present makes the scheme scoped, so a session holding
  nothing answers an empty grant rather than a bare identity, and the grant is
  the INTERSECTION of the vocabulary with the session's own `scopes` — a
  session naming a scope the scheme does not know grants nothing extra.
  `Session.scopes` is what phase 3's login writes from the token's `scope`
  claim; a session sealed without it grants nothing.

  **`principal(session)` defaults to the session's own, and refuses a `null`
  one.** The codec cannot know `P`, so `{ principal: null }` unseals happily —
  refusing it is the scheme's job, exactly as `jwtAuthenticator`'s
  `principal(claims)` may answer `undefined`. Override it for a session this
  endpoint will not take (one no OIDC login minted, one missing a tenant).

  No cookie, a cookie no key opens, an expired session and a declined
  principal are ONE answer: `Unauthenticated`, carrying no reason.

  **The codec seals a second thing, and this scheme never reads it.**
  `SessionCodec`'s `transient` pair seals the login flow's own state — a PKCE
  verifier, `state`, `nonce`, where to return to — with the same keys under
  `typ: "oidc"` and a fixed `TRANSIENT_TTL_SEC` of five minutes. A scheme reads
  `typ: "session"` only, so a client replaying its transient under the session
  cookie's name is anonymous, and the mirror holds too — which is what lets one
  key list serve both purposes. See `packages/http-server/CLAUDE.md` for why
  the pair is on the codec rather than a provider of its own.

  **Composing it turns CSRF on**, which is the one thing this scheme does that
  no header-borne one does. Its description carries `cookie: true`;
  `defineHttp` turns that into a `CookieSchemes` member beside the scheme's
  own provider, and the HTTP listener refuses a cross-site state change
  carrying cookies with a bodyless `403` before any answerer sees it. Nothing
  is written at the composition root, and `csrf: false` on `http()` /
  `HttpModule` is what turns it back off — see `csrf` in
  `packages/http-server/CLAUDE.md`. The other two shipped schemes read a
  header, and a caller presenting a header credential is not a CSRF target, so
  neither sets the marker.

- **`oidc({ principal, issuer?, clientId?, clientSecret?, redirectUri?, prefix?, scope?, postLogout? })`
  and `OidcUnreachable`** (`oidc.ts`, from `@btravstack/http-server/oidc`) —
  **the one thing in this package on the ISSUING side of the line above, and
  the exception that proves it.** It mints no credential: it walks a browser
  through somebody else's authorization-code flow and hands what comes back to
  `sessionCodec` to seal. Everything it verifies — the ID token's signature,
  `state`, `nonce`, PKCE — is verification, and the identity is still the
  provider's.

  It is an **answerer**, not a scheme: `Provider.member(HttpHandler)` beside
  `orpc()` and `htmx()`, mounted at `prefix` (default `/auth`), serving
  `GET /login`, `GET /callback` and `POST /logout` and answering `404` for
  anything else below its mount. A login is a REDIRECT protocol — three
  requests, a cookie written on two of them — and an `AuthenticatorService` is
  handed headers and answers a principal, so there is nowhere in that shape to
  put any of it. The two halves meet at exactly one place, the cookie:
  `oidc()` seals it and `sessionAuthenticator` reads it, both through the same
  `SessionCodec` port.

  **`principal(claims)` is the same hook `jwtAuthenticator` takes**, on
  `openid-client`'s `IDToken` — so an application writes ONE function and
  passes it to both, and the answer is what goes into `Session.principal`.
  Answering `undefined` refuses the login with a `400`: the claim this
  application requires and the standard does not, a tenant being the usual one.

  **`Session.scopes` comes from the ID token's `scope` claim** — space
  delimited, and a claim the standard does not put in an ID token at all, so
  a provider that does not write one leaves the field absent and a scoped
  `sessionAuthenticator` grants nothing. `Session.sid` comes from `sid`, when
  there is one. Neither is invented here.

  **The transient cookie is the flow's whole memory.** `__Host-oidc` holds the
  PKCE verifier, `state`, `nonce` and where to return to, sealed by
  `codec.transient` under its own purpose marker with a five-minute lifetime —
  so the login is stateless like the session is, and a replay of it under the
  session cookie's name is anonymous. The callback checks the returned `state`
  against it before anything is exchanged; no cookie, an unopenable one, an
  expired one and a mismatch are one `400` that sets and clears nothing.

  **`return` is decoded exactly ONCE and must stay on this site.** The query
  parser is that decode; the value survives only if it starts with `/` and its
  second character is neither `/` nor `\`. A second `decodeURIComponent` would
  turn `%255C` back into `\`, and `new URL("/\\evil.com", base)` resolves to
  `https://evil.com/` — the WHATWG parser reads `\` as `/` in relative-slash
  state — so a value that already passed the guard could be walked past it
  again. `htmx({ login })` guards the same thing where it MINTS the value; this
  guards it again where it is sealed and once more where it is followed,
  because the query is the caller's either way.

  **The code grant is checked against the REGISTERED redirect URI, never
  `Host`.** `currentUrl` is `redirectUri` carrying this request's query, so a
  forged `Host` cannot move the check — and a deployment behind a proxy needs
  no trust in that header for this to be right.

  **Discovery runs once, in `make`.** A provider that is not there is
  `OidcUnreachable` naming the issuer — a modeled startup failure beside
  `ConfigInvalid`, which `runMain` turns into an exit code — rather than a
  `500` on the first login, and the JWKS cache is one per process. The
  configuration enables the ID token **signature** check explicitly: OIDC Core
  permits a client to trust a token that came over TLS from the token endpoint,
  and that is not a trust this package extends.

  **Logout is parameterless and is a `POST`.** No `id_token_hint`, because the
  cookie carries a principal and no token — and therefore no
  `post_logout_redirect_uri`, which a provider is entitled to refuse without a
  hint. `POST` because it is a state change, which also means the CSRF check a
  composed session scheme turns on covers it, exactly as it covers any other
  cookie-bearing state change. Every redirect it writes is a `303`, `htmx()`'s
  own ruling.

- **Password hashing and credential ISSUING are out of scope, deliberately.**
  All three authenticators above are on the **verifying** side, and that is
  the line: the credential is minted by whoever owns the identity — an OIDC
  provider, a partner's key vault — and this package reads what arrives.
  A session cookie does not change it: `sessionCodec` seals a principal
  somebody else already authenticated. So a password hasher here would be a
  primitive with no surface calling it. Reach for `argon2` or
  `@node-rs/argon2` directly at whatever mints your tokens; that is one
  dependency and no framework opinion, which is the right size for it.

- **`defineHttp({ authenticators })` → `Http<A>`, carrying `OrpcController`,
  `OrpcRouter`, `authenticators`, `principals` and `units`** (`define-http.ts`)
  — **the one door** to
  the marker-typed entities, and the place a scheme registry is stated.
  **The contract says which schemes protect a route; this says what each one
  resolves to.** `SchemesFrom<A>` reads the registry off the authenticators
  (`{ [K in keyof A]: A[K]["principal"] }`) rather than having it declared a
  second time, and `Implementation<C, Schemes>` / `ContextOf<C, R, Schemes>`
  carry it down to each leaf. Declaring a scheme and implementing it are **the
  same act**, so a scheme with no authenticator is not a state this can reach —
  there is no coverage gate because there is nothing to forget.
  `Schemes = never` is "no factory": a marked fragment reached through anything
  but a `defineHttp` call types `principal: never` and **any read of it is a
  compile error** (measured: TS2339 on a property of `never`). That is the
  "use the factory" signal. `controllerFor` and
  `routerFor` are exported from their own files for this factory alone, not
  from `index.ts`, and there is **no** top-level `OrpcController` / `OrpcRouter`
  any more: a form whose principal could only ever be `never` was a trap with
  no correct use.
  The default type argument is `Record<never, never>`, **not**
  `Record<string, never>`: an index signature over `string` would make every
  scheme's port look available to di, so a marked contract composed under
  `defineHttp()` would type-check and then fail at build. Empty, the port stays
  unmet and the composition is refused.
  **The result is held as ONE binding and never destructured.** Each binding of
  a destructured member expands to a type mentioning `@btravstack/contract`'s
  inaccessible `unique symbol`, which is TS2527 (measured); held whole, the
  inferred type collapses to `Http<A>`, which is nameable — so an application
  writes **no type annotation at all**, and the three `…Of<Identity>` aliases
  the previous factory needed are gone with the annotations they existed for.
  **`principals` and `units<U>()`** are the unit-kinds half: one principal port
  per declared scheme, and a second call that retypes the same object by the
  module each kind binds. The ports also reach the answerers at RUNTIME —
  `defineHttp` hands the record to `routerFor` and `htmxFragmentsFor` beside
  the authenticators — since a seed needs the port object, not only its type. The two steps exist because a unit module names
  `auth.principals.<scheme>` in its `needs`, so folding the kinds into
  `defineHttp` itself would make `auth` reference its own type — TS7022. The
  reasoning and the `UnitsOf` weak-type rule are in
  `packages/http-server/CLAUDE.md`.
  At runtime the call binds one provider per scheme —
  `Provider(authenticatorPort(scheme))(options)`, the very options object
  `HttpAuthenticator` held on to — and hands them to
  `routerFor`, which carries them out on `provider.authenticators`.
  It is **per application, not per slice**, and that is forced rather than
  chosen: a handler's parameter types are fixed where the arrow is written, so
  a composition root cannot retroactively re-type a `sync` callback in another
  module. The registry must be in scope where the handler is, and the factory
  is how it gets there with no per-call-site annotation.
  What it replaced: a principal type named in the contract, which put the
  server's own view of a caller — a user id, roles — in the artifact a client
  imports; and then a single-identity factory, which named **one** identity per
  application and so could not describe a route two different kinds of caller
  may reach. Pinned by `define-http.test-d.ts` (the registry inferred from the
  authenticators, the no-argument call, an authenticator's own dependency
  riding through), by `auth.test-d.ts`'s arms 7–12, and at runtime by
  `auth.spec.ts`'s `rpcAuthed`, `rpcRootMarked` and `rpcVerified` fixtures.
- **`resolveScheme(requirements, authenticators, headers)` →
  `AsyncResult<{ scheme, identity }, Unauthenticated | UnderScoped>`**
  (`auth.ts`) — the authentication walk, protocol-neutral: headers in, the
  scheme that answered and what it answered with, or a typed refusal, out —
  with no oRPC in the signature. It tries the requirements **in the order the
  contract declared them**, taking the first a caller satisfies. Every answerer
  shares this one walk, so a scope check cannot drift between protocols. It
  reports the SCHEME on every success rather than only on a multi-scheme leaf,
  because the scheme is also the **unit kind** the request opens under, which
  every leaf has whether or not its handler is told which one answered.
  `principalOf(requirements, resolved)` is the fold to what a handler is
  injected, and `resolvePrincipal` is the two composed — the shape `index.ts`
  exports, unchanged. Four decisions live here, each pinned by `auth.spec.ts`:
  - **Tagged when the leaf names more than one SCHEME**, not more than one
    requirement — `new Set(requirements.flatMap(Object.keys)).size > 1`, in
    `principalOf`, the one site both answerers fold through. One
    requirement may name several schemes, and counting requirements disagreed
    with `SchemesOf`, which unions scheme names across all of them: the handler
    typed `Tagged` while this injected bare, so `principal.scheme` read
    `undefined` with **no type error to catch it**.
  - **A required scope is not satisfied by a credential reporting none.** A
    scheme declared without a vocabulary answers bare, and skipping the
    comparison for it admitted the caller outright — the one place in this
    package where the failure direction matters. An empty `required` still
    passes trivially.
  - **`UnderScoped` is not `Unauthenticated`.** A credential that was valid but
    under-scoped answers `UnderScoped`; only a caller no requirement accepted
    at all answers `Unauthenticated`. Neither carries a reason: the refusal is
    typed, not messaged, so what a caller is told is each answerer's own
    decision. **The distinction is what makes `htmx({ login })` possible**:
    only `Unauthenticated` is a caller a login can help, so that is the one
    case sent to `/auth`, and an `UnderScoped` caller — logged in, and still
    not allowed — keeps its `403` rather than being taught a loop through a
    login it already completed.
  - **A defect short-circuits rather than falling through.** A defect is a bug
    in the authenticator, not a refusal; falling through would let a broken
    verifier silently promote every caller to the next scheme. It stays on the
    defect channel rather than becoming an `Err`.

  The authenticators arrive as a plain record keyed by scheme, and the lookup
  is **asserted, not guarded**: the router declares one dep per scheme its
  contract names, so every scheme a requirement names is a key here and di
  refuses the graph long before a request lands. That is also why
  `noAuthenticator` — the fail-closed stand-in the single-scheme design needed
  — is gone: there is no "marked but unwired" state left for it to cover.

- **`principalMiddleware(requirements, authenticators)`** (`auth.ts`, internal —
  not exported from `index.ts`) — oRPC's adapter over `resolvePrincipal`, and
  the one middleware this package installs, only on a leaf whose effective
  requirements say so. It reads the request off oRPC's **initial context**
  (`orpc()` passes `context: { request }` to `RPCHandler.handle`, which is what
  initial context is for), calls `resolveScheme` with the headers, and turns
  its two error cases into `throw new ORPCError("UNAUTHORIZED")` for
  `Unauthenticated` and `("FORBIDDEN")` for `UnderScoped` — oRPC's middleware
  protocol has no returned-error arm, which is the one place in this package a
  `throw` is right, carried by an `unthrown/no-throw` disable naming why, and
  **neither derives a message from the refusal**: oRPC serializes `message` to
  the client, so the caller gets oRPC's default and the reason never leaves the
  process. A defect from the walk is rethrown as its own cause, so it stays
  oRPC's `INTERNAL_SERVER_ERROR` collapse. On success it injects
  `{ context: { principal, resolved } }` through `next` — `principal` for the
  handler, `resolved` for `unitScope`, which reads `resolved.scheme` as the
  unit KIND and seeds the fork with `resolved.identity` on that scheme's
  principal port. The kind selects `units[scheme] ?? units.anonymous` — a
  scheme that binds no module of its own falls back, so binding `{ anonymous }`
  alone keeps forking on every leaf, and a scheme's module is how one kind is
  specialised rather than how the others are switched off. The seed lands
  whichever module is forked; an unread entry is the whole cost.

- **A contract may name a scope only if the scheme's authenticator can grant
  it — for an oRPC contract.** `routerFor` intersects `ScopeGate<C, Vocab>`
  onto its `contract` parameter — `unknown` when satisfied, an object with one
  required property when not, which is what makes the diagnostic end on the
  offending scope (measured: `… "UNGRANTABLE SCOPE — its scheme's
authenticator cannot grant it": "order:export"`). `VocabFrom<A>` reads the
  vocabulary off the same authenticators `SchemesFrom<A>` reads the principals
  off — two projections because they answer different questions at different
  call sites: the principal types the handler, the vocabulary checks the
  contract.

  **The fragment path carries the same gate, at the route's own mint.**
  `htmx-route.ts`'s `HtmxGet`/`HtmxPost` intersect `RequiresGate<R, Vocab>`
  onto their `requires` option — `ScopeGate` with the contract fold removed,
  since a route's `requires` is data rather than a tree to walk — so
  `api.HtmxGet("/orders", { requires: [{ user: ["orders:export"] }] })` against
  a `user` authenticator that can never grant it fails the same
  `"UNGRANTABLE SCOPE — its scheme's authenticator cannot grant it"` sentence
  `routerFor` gives an oRPC contract, named at the mint rather than discovered
  in production.

  Two cases the oRPC gate catches, and both used to be silent (#90): a typo, and a scope
  asked of a scheme declared with no vocabulary at all — `Scope = never`, so
  everything is ungrantable. Both compiled, passed all six gate commands, and
  then refused every caller on that route with a permanent 403 and no
  diagnostic anywhere. It is the sibling of the scheme-NAME check, which di
  performs already by leaving an unknown scheme's port unmet — and the two do
  NOT overlap: a scheme the registry does not know is skipped by this gate
  entirely, so a misspelled scheme naming scopes reports the port it cannot
  discharge (`PortInstance<"HttpAuthenticator:usre", …>`) rather than a scope
  complaint. Treating an unknown scheme as an empty vocabulary made every scope
  it named ungrantable, which was the wrong diagnostic AND the earlier one,
  since this gate sits on the router mint and the unmet port on the composition
  root.

  A requirement naming no scopes contributes `never` and costs nothing, which
  is the common case. One shape inside is load-bearing: `ScopesIn` asks
  `K extends keyof R[I]` **before** indexing, because indexing a requirement
  that does not name `K` gives `never`, and inferring the element type from
  `never` falls back to its constraint — `string` — so every scope looked
  grantable the moment two requirements named different schemes. Measured; do
  not "simplify" it back to `R[I][K & keyof R[I]]`.

- **The scheme dependencies are read off the contract, and the two halves must
  agree — a disagreement is an auth bypass.** `routerOf` walks the
  **contract** alongside the implementer, carrying an `inherited` requirements
  value —
  `isAuthenticated(node)` answers for one node only, so a marked record's
  requirements are
  pushed down by the walk exactly as `Inherit<T, R>` pushes them in the types,
  and a node's own mark **replaces** what it inherited, exactly as
  `Effective<C, R>` does — and a leaf with effective requirements becomes
  `node.use(principalMiddleware(effective, authenticators)).result(fn)`. **`.use` before
  `.result`, never the reverse**: `.result` returns an `ImplementedProcedure`
  whose own `.use` has no `.result` left. Three things keep the two halves
  from parting:
  - **The walk is seeded with `isAuthenticated(contract)`, not `undefined`.** The
    root node has no `contract[key]` to be read from, so a marked **root** —
    `api.OrpcRouter(authenticated({ user: [] })(contract))` — would otherwise wrap nothing at
    all while `Implementation<C, Schemes>`'s record arm typed every leaf with a
    principal that never arrived. Pinned by `auth.spec.ts`'s
    `rpcRootMarked` fixture, mutation-verified.
  - **`schemesOf` enters every object, not only plain records**, cycle-guarded
    by a `WeakSet` (a schema is free to be recursive), and does **not** stop at
    a mark — a procedure inside a marked record may name a scheme of its own,
    and that scheme still needs a port. Anything it declines to
    enter is a mark it can miss and the walk cannot, and missing one is the
    unsafe direction; over-approximating only ever declares a port nothing
    uses. Its type-level twin is `SchemePortsOf<C>`, built on
    `AllRequirementsOf<C>` — a tree walk keeping every requirement it finds —
    and the two must agree.
  - **A scheme with no authenticator behind it does not build.** There is no
    fail-closed stand-in any more, and none is wanted: the router names one
    port per scheme, `defineHttp` binds one provider per authenticator, and a
    scheme in the first set but not the second is di's own unmet need naming
    `HttpAuthenticator:<scheme>` — refused before a request can arrive rather
    than answered `401` once one has.

  It also takes **`needs`**, forwarded to di's own — what this root's OWN
  providers expect from outside. `Env` is never among them: the starter is an
  import, and an import's needs travel without being restated, while a scheme
  that configures itself from the environment is a provider of this root's and
  would otherwise have to be declared — so the sugar adds `Env` to what the gate
  counts as declared (`EnvAnd<N>`), which is legal because di's `needs` array is
  type-level only and over-declaring is free. Another starter's sugar makes no
  such promise: `examples/order-amqp-worker` says `needs: [Env]` for
  `relayConfig`. The sugar
  **re-declares di's `NeedsGate`** over its augmented tuples, so a root whose
  own provider owes a port it does not name is refused at THIS call rather than
  slipping past into `start`; see `packages/di/CLAUDE.md`'s **Module
  visibility**.

  For every scheme `schemesOf(contract)` found, that scheme's port joins the
  provider's `inject` record under the **namespaced**
  key the `AUTHENTICATOR` constant builds — `"@btravstack/http-server/authenticator"`
  plus a trailing colon, then the scheme name — namespaced for the same reason
  `tapped`'s port id is, since every other key on that record is a name the
  caller chose and these must not be able to collide with a dependency
  somebody called `user`; `sync` reads them off the services record into the
  record `principalMiddleware` takes and
  hands the caller's own `sync` the rest — and all three `build` overloads add
  `SchemePortsOf<C>` to the needs channel
  plus `readonly authenticators` to the result.
  A router naming a scheme nobody implements is therefore an
  ordinary unmet need refused at `start` — no new gate, and not di's dependency
  gate. There is nothing left for a
  gate to check afterwards: the registry that types the handlers and the
  providers that discharge the ports come from the **same** `defineHttp` call,
  so they cannot disagree. Note
  `oc.router(...)` **rebuilds** every node, so a marker applied inside a
  builder chain is lost — on **both** sides at once
  (`AugmentedContractRouter<T, …>` maps `[K in keyof T]` and answers `never`
  for the phantom key, so `IsMarked` loses it too), which makes it a
  dropped protection rather than a bypass. `authenticated(...)` is applied to
  the finished node, which is what `@btravstack/contract` already documents.
