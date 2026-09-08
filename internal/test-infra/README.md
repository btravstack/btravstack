# @btravstack/internal-test-infra

The repository's shared test infrastructure. Private, never published, and not
an example of anything — it exists so the gate needs **one** of each server
rather than one per workspace.

## What it starts

| Container                          | Who uses it                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `postgres:18.1`                    | Temporal's own persistence, and the example application's `orders` database |
| `rabbitmq:4.2.1-management-alpine` | `packages/amqp-worker`, `examples/order-amqp-worker`                        |
| `temporalio/auto-setup:1.29.1`     | `packages/temporal-worker`, `examples/order-temporal-worker`                |
| `redis:8.8.2-alpine`               | `packages/cache`, `examples/order-api`                                      |
| `axllent/mailpit:v1.31.0`          | `packages/mailer`, `examples/order-amqp-worker`                             |
| `rustfs/rustfs:1.0.0-rc.3`         | `packages/storage`                                                          |
| `nginx:1.29-alpine`                | the dev loop's JWKS endpoint, and `src/dev-issuer.spec.ts`                  |
| `oryd/hydra:v2.3.0`                | the OpenID provider the backend-for-frontend authorises against             |
| `oryd/kratos:v1.3.1`               | the identity provider Hydra delegates login to                              |
| `node:24-alpine`                   | `src/ory-consent.mjs`, the consent and logout endpoint                      |

One container per backing service — the table above is the list, and the
workspaces reading each are in it. Before this existed, the broker and the
workflow platform were started per workspace instead: two RabbitMQ containers
and up to three Temporal time-skipping servers, and `pnpm test` was
intermittently red at turbo's
default concurrency because the 60s testcontainers startup wait was what gave
out first ([#52](https://github.com/btravstack/btravstack/issues/52)).

## Isolation is logical, not physical

Sharing a server costs nothing because each system already has a boundary
finer than "a server of my own":

- **A vhost per test.** `@amqp-contract/testing`'s `it` extension already
  minted one from the management API; only the container was ever duplicated.
- **A namespace per spec file.** `createNamespace` registers one and waits for
  every Temporal service's registry to catch up before returning it — a
  `startWorkflow` issued the instant `registerNamespace` resolves fails with
  `NamespaceNotFound` until they do. Per file rather than per test because
  registration costs that refresh, and a task queue per test (which both
  suites already mint) is what separates tests inside a file.
- **A tenant per test.** The example application is multi-tenant, so one
  migrated database serves the whole gate. See
  `examples/order-infrastructure/README.md`.
- **A key prefix per test.** A Redis test mints `test:<uuid>:` and writes
  under it, which is finer than a database index and, like every boundary
  here, needs no cleanup.
- **A recipient per test.** Mailpit delivers nowhere and keeps everything, so
  a UUID localpart is a mailbox nobody else reads — and one nobody has to
  purge.
- **A key prefix per test** in object storage too, inside one bucket: a bucket
  per test would be a create-and-delete round trip bought for an isolation a
  UUID prefix already gives for nothing.

## The `orders` database has two roles

The container's bootstrap user owns the schema and applies the migrations. It is
a **superuser**, and a superuser bypasses row security whatever
`FORCE ROW LEVEL SECURITY` says — so a policy exercised through it would pass
while proving nothing.

`provisionApplicationRole` therefore creates `orders_app`,
`NOSUPERUSER NOBYPASSRLS`, and grants it the whole `public` schema. That is the
role every `order-infrastructure` spec, both worker examples' fixtures and
`pnpm dev` connect as — `__ORDERS_DATABASE_URL__` and `.env.dev`'s
`DATABASE_URL` carry its credentials, and `DATABASE_URL` stays the one variable:
the owner's URL never leaves the setup that migrates with it.

It runs **after** `prisma migrate deploy`, because `ON ALL TABLES` covers only
what already exists; `ALTER DEFAULT PRIVILEGES` is what covers a table or
sequence a later migration adds. The grant on **sequences** is the one that
looks optional and is not: `Order.id` is `autoincrement()`, so without it every
insert fails with a permission error that reads nothing like an RLS refusal.

The DDL is idempotent — a `DO` block swallowing `duplicate_object`, and grants
that restate — because a reused container outlives the run and the role is
already there on the second one.

**A deployment's version of this DDL wants one more line, and this one does
not.** `GRANT … ON ALL TABLES` reaches `_prisma_migrations` like any other
table, so `orders_app` can rewrite the record of which migrations ran. Here that
is harmless — the setup migrates again on every run and the container is
disposable — but in production nothing the application does should be able to
touch it, so the DDL there ends with
`REVOKE ALL ON "_prisma_migrations" FROM orders_app;`. The reference page's copy
carries that line; see `docs/reference/prisma.md`.

## Reuse, and what it costs

`withReuse()` is what makes the second, third and fourth workspace attach to a
container instead of starting one: testcontainers hashes the creation options
and fetches by that hash. Two consequences are deliberate.

**A reused container is not registered with Ryuk, so it outlives the run.**
That is the trade — a warm container costs nothing to attach to, and a cold one
costs the image pull the issue was about. To remove them:

```sh
docker rm -f $(docker ps -aq --filter label=com.btravstack.test-infra)
docker network rm btravstack-ory
```

**testcontainers' own reuse lock is in-process**, which does nothing about the
case this repository actually has: turbo starting several workspaces' vitest
runs at the same instant, each missing the fetch-by-label and each starting a
container. `withLock` is a `mkdir`-based file lock under `<repo>/.cache/`
(gitignored) that closes it.

A file lock has one failure mode worth naming, because this repository hit it:
**a holder that is killed never releases.** Turbo cancels sibling tasks as soon
as one fails, so a waiter timing out takes down the very process holding the
lock, and the next run then queues behind a lock nobody owns. `withLock`
therefore writes its **pid** into the lock and treats a lock whose process is
gone as free immediately — `process.kill(pid, 0)`, which checks liveness
without delivering a signal. The time-based window is only the fallback for
what a pid cannot answer (another machine, a recycled number), and it is
deliberately **shorter** than the wait: a stale window longer than the wait can
never self-heal, because every waiter gives up before the lock is old enough to
break.

## Entry points

| Import                                       | What it is                                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@btravstack/internal-test-infra/rabbitmq`   | a vitest `globalSetup` providing `@amqp-contract/testing`'s inject keys                                                                                                                                |
| `@btravstack/internal-test-infra/temporal`   | a vitest `globalSetup` providing `@temporal-contract/testing`'s                                                                                                                                        |
| `@btravstack/internal-test-infra/containers` | `sharedPostgres` / `sharedRabbitMq` / `sharedTemporal` / `sharedRedis` / `sharedMailpit` / `sharedRustFs`, plus `postgresUrl`, `provisionApplicationRole` and the credentials each one is started with |
| `@btravstack/internal-test-infra/namespace`  | `createNamespace(address, prefix)`                                                                                                                                                                     |
| `@btravstack/internal-test-infra/ory`        | `sharedOry` / `provisionOry` / `createIdentity` / `registerRedirectUri`, the issuer and client constants, and `ORY_USERS`                                                                              |
| `@btravstack/internal-test-infra/ory-login`  | `oryClient()`, `headlessLogin({ authorizationUrl, user })` and `followRedirects(from, until)`                                                                                                          |
| `@btravstack/internal-test-infra/lock`       | `withLock(name, run)`                                                                                                                                                                                  |

## The dev issuer

`order-api`'s `user` scheme verifies a **real** OIDC token against a real JWKS,
so the dev loop needs an issuer of its own — the specs use
`@btravstack/testing/jwt`'s in-process `localIssuer` and never come here.

`src/dev-issuer.ts` is that issuer, in three parts:

- **A key pair under `<repo>/.cache/dev-issuer/`** (`private.jwk` +
  `public.jwk`, RS256, `kid: "dev"`), minted on first use and read back for
  ever after. Persisted rather than minted per run for one reason: a token
  pasted into a terminal yesterday still verifies today, and a `pnpm dev:env`
  between the two changes nothing.
- **A container serving it.** `nginx:1.29-alpine` with
  `{ "keys": [publicJwk] }` copied in as `/jwks.json` — a real endpoint, so
  `jose`'s `createRemoteJWKSet` does a real fetch over the network. `dev:env`
  starts it beside the other six, and it carries the same
  `com.btravstack.test-infra` label. The key's RFC 7638 **thumbprint is one of
  its labels**, and labels are part of what testcontainers hashes for reuse: a
  new key pair therefore gets a new container rather than one still serving the
  old public half. The copied file could not express that on its own — content
  is copied after create and is not hashed — and the container the old key left
  behind goes with the `docker rm -f` above.
- **`signDevToken`**, behind `pnpm dev:token`.

```sh
# mint into a variable and check the status — never `$(…)` straight into the
# header, see below. The tenant is one the dev loop already relays the outbox for
TENANT=0199a1e0-0000-7000-8000-000000000001 # a UUIDv7
TOKEN=$(pnpm dev:token -- --tenant "$TENANT") || exit

# the port is the one the API's `serving` event logged, `PORT=0` in its dev script
curl -s -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' -d '{"json":{}}' \
     http://localhost:57234/rpc/orders/list
```

`--tenant` is required and must be a **UUIDv7**: `principal` parses it with
`z.uuidv7()`, and `uuidgen` and `crypto.randomUUID()` both mint a v4, which
comes back as a 401 rather than as an error naming the mistake. Mint one with
`node -e 'import("uuidv7").then((m) => console.log(m.uuidv7()))'`, or reuse the
`OUTBOX_TENANTS` value above. `--sub` defaults to `u-1` and `--scope` to
`orders:export` (what `orders.export` requires; nothing else does). A missing
`--tenant`, one that is not a UUIDv7, and an unknown flag all print the same
one-line usage on stderr and exit `64`.

**Mint into a variable, and check the status.** The _script_ writes the token
and nothing else to stdout — but `pnpm` writes its own
`[ELIFECYCLE] Command failed with exit code 64.` **to stdout** when the script
exits non-zero, and `--silent` does not suppress it. So a
`curl -H "authorization: Bearer $(pnpm dev:token …)"` sends that line as the
bearer token on the very mistake the UUIDv7 check exists to catch, and the real
usage line is scrolled off in stderr. `TOKEN=$(…) || exit` is what makes the
failure a failure.

## Ory: three containers, and why each one is there

`src/ory.ts` starts the OpenID provider the stateless backend-for-frontend is
built against, and provisions it. Measured in a spike before any of it was
wired in; the shape below is what worked.

- **`oryd/hydra:v2.3.0`**, `serve all --dev`, no config file and seven
  environment variables. `URLS_LOGIN` points **straight at Kratos's own
  browser-login endpoint**, which is what removes the login UI application: Hydra
  appends `?login_challenge=…`, Kratos consumes it and calls Hydra's
  accept-login itself.
- **`oryd/kratos:v1.3.1`**, with `config/kratos.yml` and
  `config/identity.schema.json` copied to `/etc/config/`. The identity schema is
  what puts `tenant` on an identity, beside the `email` that is its login
  identifier.
- **`node:24-alpine` running `src/ory-consent.mjs`**, and it is not optional.
  `skip_consent` and `skip_logout_consent` are advice **to a consent
  application** — Hydra echoes them back and still redirects the user agent to
  `URLS_CONSENT` and `URLS_LOGOUT`. There is no mode in which either endpoint is
  unreachable, so without this container the code flow does not complete at all
  and logout dead-ends at a connection refused. Kratos also passes no traits
  through the login accept (`context: null`), so the handler reads the identity
  itself — `request.subject` **is** the Kratos identity id, which makes it one
  admin `GET` — and writes `tenant`, `email` and `scope` into `session.id_token`.
  `scope` has to be written in by hand: Hydra never puts it in an ID token, and
  its access token is opaque.

  The reference image `oryd/kratos-selfservice-ui-node` was measured and
  declined. It completes the flow, but its claim mapping is a hardcoded switch
  over seven OIDC-standard names with no trait passthrough and no template, so
  `tenant` cannot arrive; and it is 1.18 GB against Hydra and Kratos's 169 MB
  combined.

**Fixed host ports — 4444/4445, 4433/4434, 4455 — rather than the ephemeral
ones every other container here takes.** A redirect protocol needs its URLs
before the container exists: Hydra's issuer and `URLS_*` are baked into the
environment it starts with, and a client's `redirect_uris` are registered
against them. Fixing them also makes the URLs identical from the host and from
inside a container, which is what lets `URLS_LOGIN` point a browser straight at
Kratos. Host bindings are not part of what testcontainers hashes for reuse, so
this costs nothing there. The cost is a collision: anything else already
listening on one of the five refuses the container with
`Bind for 0.0.0.0:4444 failed: port is already allocated`, which names the port
and not the reason. Two causes look the same: a host process on the port, which
`lsof -nP -iTCP:4444 -sTCP:LISTEN` names; or a STALE sibling of the same
container, which is what an edit to `ory-consent.mjs`, `kratos.yml` or
`identity.schema.json` leaves behind — the edit mints a new reuse hash while
the old container still holds the port. `docker ps` shows that one; the fix is
`docker rm -f $(docker ps -aq --filter label=com.btravstack.test-infra)` and
a fresh run. A bind that failed this way also leaves the NEW container created
but unpublished, and the next run attaches to it and fails with
`No host port found for host IP` — the same command clears that too.

**One user-defined network, `btravstack-ory`, created by name rather than by
testcontainers' `Network`.** That class mints a random name a second process
cannot find and labels it with the reaper's session id, so it would be removed
under a reused container. `sharedOry` looks the network up and creates it if
absent, under a lock, with the same `com.btravstack.test-infra` label as the
containers. Only one call ever crosses container to container — Kratos → Hydra
admin — so aliases exist for `hydra`, `kratos` and `consent` and everything else
is a browser redirect to `localhost`.

**Copied content rides a label.** Content is copied into a container _after_
create and is not part of the reuse hash, so an edited `kratos.yml` or
`ory-consent.mjs` would be reused into a container still running the old copy.
Each of the two carries a digest of what it copies under
`com.btravstack.ory-content`, the same trick as the dev issuer's key thumbprint.

**Provisioning runs on every attach, not once.** Both DSNs are `memory`: a
container that is _attached_ to keeps its state, but one that was restarted has
forgotten every identity, client and signing key. `provisionOry` is idempotent
by lookup-then-create — neither admin API has an upsert — and costs about a
third of a second, so running it unconditionally is the honest default. Moving
to the shared `postgres:18.1` would buy durable state at the cost of two
databases, two migration steps and a Postgres dependency in the wait strategy.

Two gotchas worth not rediscovering: Kratos's admin API lives under an `/admin`
prefix, so `/health/ready` on 4434 is a **307** and the wait strategy must ask
for `/admin/health/ready`; and `config/kratos.yml`'s `ui_url`s are deliberately
dead — Kratos 303s to them carrying `?flow=<id>`, and a headless driver reads
the id out of the `Location` header without ever issuing the request.

`ORY_USERS` is two identities in two tenants, so a spec can prove one is not the
other. Their passwords, `ORY_CLIENT_SECRET` and Hydra's `SECRETS_SYSTEM` are
constants in the source on the same footing as `POSTGRES_PASSWORD`: nothing
outside this repository authenticates with them.

**The per-test boundary here is an identity, never a client.** `createIdentity`
is the same lookup-then-create `provisionOry` runs, exported on its own and
answering the Kratos id — which is the `sub` the tokens carry — beside
`"created"` or `"existing"`. A spec that needs state nobody else touches mints a
user, exactly as a Redis spec mints a key prefix. A client per test would be a
second registration against the one provider for an isolation an identity
already gives.

## Signing in without a browser

`src/ory-login.ts` is `headlessLogin({ authorizationUrl, user })`. It takes an
authorization URL the caller built — `openid-client`'s `buildAuthorizationUrl`,
or by hand — walks the authorization redirect out to Kratos, submits the
password through Kratos's own self-service API, and walks the verifier back
through Hydra and the consent handler. What it answers is the callback URL Hydra
redirected to, carrying `code` and `state`. It never fetches that URL: nothing
serves `ORY_REDIRECT_URI`, and what a test wants is the code, not a response to
it — which is why the last hop below is the **caller's** and not the driver's:

1. `GET` Hydra's `/oauth2/auth` → 302 to Kratos's `/self-service/login/browser`
2. `GET` that → 303 to `ui_url?flow=<id>`, **which is never fetched** — the id is
   read out of the `Location` header, and the UI URL stays the dead one
   `config/kratos.yml` names
3. `GET` Kratos's `/self-service/login/flows?id=` with `Accept: application/json`
   → the flow, whose `ui.action` is where to post and whose `csrf_token` node
   carries the token to post with
4. `POST` that action, JSON `{ method, identifier, password, csrf_token }` → a
   **422**, which is Kratos's normal answer for a browser flow that must be
   redirected; the body carries `redirect_browser_to`
5. `GET` Hydra's `/oauth2/auth?login_verifier=…` → 302 to consent
6. `GET` our own `/consent?consent_challenge=…` → 302 back
7. `GET` Hydra's `/oauth2/auth?consent_verifier=…` → 303 to the callback
8. the token exchange, which is the caller's — `authorizationCodeGrant`

Every one of these is Kratos's or Hydra's own documented API. There is no
scraping, no HTML parsing and no reference-UI route, which is what makes this
the most stable of the headless logins the spike compared.

**A step that answers something other than a redirect is reported, not waited
on.** A stale consent challenge answers 400 from the handler and Hydra down
answers 502; either way the walk rejects naming the status and the body, so a
broken container reads as a failure rather than as a hang against the 180 s
timeout.

**The cookie jar is module-scoped and cleared by every login**, because a
browser has one of these. That is what lets the logout walk carry the session
the login left — `followRedirects` shares the jar, which is how
`buildEndSessionUrl`'s three hops (Hydra, our `/logout`, Hydra again) reach the
post-logout URI. It is also what stops a second login being silently skipped:
Kratos would recognise the first user's session and Hydra would hand back her
token for his sign-in. `ory.spec.ts` signs both `ORY_USERS` in for that reason.

**A code grant does not verify the ID token's signature, and that is what
`enableNonRepudiationChecks` is for.** `authorizationCodeGrant` checks `iss`,
`aud`, `exp`, `iat`, `sub`, the signing algorithm and the clock skew, and never
touches the JWKS: OIDC Core §3.1.3.7 lets a client trust a token that came back
over TLS from the token endpoint it authenticated to. This issuer is `http://`,
so nothing backs that. Without the call, a Hydra serving a key set that cannot
verify its own tokens — a rotated `SECRETS_SYSTEM`, a stale sibling container on
`:4444` — passes every test here and fails only in the application, whose `user`
scheme has the JWKS and no token endpoint to trust. `at_hash` is not checked in
this flow either, whatever the spike report said.

Two more things the flow needs that reading the OpenID spec does not suggest.
`allowInsecureRequests` is needed **twice** — in `discovery`'s `execute` option
and again applied to the returned configuration, which the option does not reach
— and that too is about this issuer being `http://`, not about Hydra. And Hydra
refuses `post_logout_redirect_uri` **without `id_token_hint`**, answering
`invalid_request` on its own error page rather than a redirect — which is why
the logout the design ships, and the logout `ory.spec.ts` proves, is the
**parameterless** end-session: Hydra ends its own session from its own cookie
and lands on `URLS_POST_LOGOUT_REDIRECT`, the cookie the application seals
stays principal-only, and a fresh authorization afterwards reaches Kratos's
login again rather than the callback.

**`oryClient()` is the configured `openid-client` the phases after this one
reuse**: discovery against `ORY_ISSUER` with the client's secret, both
`allowInsecureRequests` placements, and `enableNonRepudiationChecks`, in that
order, so a caller gets a configuration whose grants verify signatures without
rediscovering either subtlety. **`registerRedirectUri(uri)`** adds a redirect
URI to the one client, idempotently, for a spec whose server binds an ephemeral
port; `provisionOry` registers `ORY_REDIRECT_URI` the same way on every attach,
so a container carrying an older registration converges.

## The two scripts

Neither is an entry point. The first is `pnpm dev:env`
(`src/dev-env.ts`), which the repository's `pnpm dev` runs first. It starts the
same containers, applies the example application's migrations with
`prisma migrate deploy` under the same `withLock` its vitest `globalSetup`
uses, and writes the repository root's `.env.dev` — the addresses each example
process reads through Node's `--env-file`, the `HTTP_JWT_*` three the dev
issuer above supplies included. Same containers, attached to rather than
duplicated: a dev loop and a `pnpm test` can run side by side. `pnpm dev:token`
is the second, and needs nothing running but the JWKS container `dev:env`
started.

**`dev:env` starts and provisions Ory too, so the dev loop's logins are
`ORY_USERS`** — `alice@btravstack.test` and `bob@btravstack.test`, both
`correct-horse-battery-staple`, which are gate constants and not secrets. The
five variables that go with them — `HTTP_OIDC_ISSUER`, `HTTP_OIDC_CLIENT_ID`,
`HTTP_OIDC_CLIENT_SECRET`, `HTTP_OIDC_REDIRECT_URI` and `HTTP_SESSION_KEYS` —
are written for the later phases of
[#160](https://github.com/btravstack/btravstack/issues/160); nothing reads them
yet, and the login route a browser would use arrives with them. `HTTP_SESSION_KEYS`
is a comma-separated **list** where the first key seals and every one unseals,
which is what a rotation needs; the dev loop writes one — 32 random bytes,
base64url, minted on the first `dev:env` and read back from
`<repo>/.cache/dev-session/keys` (mode `0600`) ever after. Persisted for the dev
issuer key pair's reason: a cookie sealed before a `dev:env` still opens after
it. The Ory containers are the exception to that, and the provisioning paragraph
above is why — both DSNs are `memory`, so a **restart** (as against an attach)
loses every identity, client and signing key, and any session cookie the loop
was holding stops resolving. `dev:env` re-provisions on every run; signing in
again is what recovers the rest.

The two setup modules are drop-in replacements for
`@amqp-contract/testing/global-setup` and
`@temporal-contract/testing/global-setup`: they provide the **same** inject
keys, so both upstream `it` extensions keep working unchanged.

**Each setup declares the keys it provides**, in its own module, and a
workspace pulls in the augmentation for exactly the setups it registers — so
the `import type` list in a `src/vitest.d.ts` mirrors the `globalSetup` list in
the `vitest.config.ts` beside it, and `inject` knows only what that run
actually started. `examples/order-infrastructure/src/global-setup.ts` follows
the same rule for its own `__ORDERS_DATABASE_URL__`. One caveat, which costs an
afternoon if missed: an augmenting module needs `import type {} from "vitest"`
of its own, because TypeScript can only augment a module the program has
already loaded.

## Running the gate needs Docker

Every workspace that boots the example application or a broker-backed runtime
needs a daemon — **and so does this one**, since `dev-issuer.spec.ts` starts the
JWKS container to fetch a real key set back off it. A warm `pnpm test` attaches to what is already running, so the
image pulls are paid once per machine rather than once per run — which is the
property worth knowing; the wall clock is whatever your machine and your
concurrency make it.

## Not here: UUIDv7

The tenant fixtures need a real UUIDv7 — `crypto.randomUUID()` mints v4, which
`z.uuidv7()` rejects — and this package used to hand-roll one. It is the
[`uuidv7`](https://www.npmjs.com/package/uuidv7) package now, taken directly by
the four example workspaces that mint ids.

The hand-rolled fifteen lines were correct, and had a spec proving a thousand
minted ids were valid and distinct. What they did not have was a reason to
exist: the rule that makes this repository hand-roll `Config` rather than take
a schema library protects **consumers of published packages**, and this
workspace is `private` and reaches none. So the trade was fifteen lines of
RFC 9562 layout, verified once and unlikely to be read again, against a
zero-dependency package that also orders ids minted within the same
millisecond — which nothing needs today.
