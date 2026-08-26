# @btravstack/contract

## 0.6.0

### Minor Changes

- d6c035a: Health checks: a module declares one, the kernel serves them at `/healthz`.

  ```json
  {
    "status": "unhealthy",
    "components": [
      { "name": "cache", "status": "healthy" },
      {
        "name": "database",
        "status": "unhealthy",
        "reason": "connection refused"
      }
    ]
  }
  ```

  `@btravstack/cache`, `@btravstack/storage` and `@btravstack/prisma` each
  contribute a check. An application composing them wires nothing: one unhealthy
  component makes the whole application unhealthy, and the report names every
  component rather than stopping at the first failure.

  **`Port.many`/`Provider.member` are back in `@btravstack/di`.** They were
  removed because an audit found no consumer — true then, and false as soon as a
  second feature wanted the shape. A set port is what lets a starter DECLARE a
  check rather than register one: a registry the kernel handed out would
  type-check whether or not the call was ever made, so a starter that forgot
  would compile and report healthy forever.

  A set port nobody contributed to now resolves to `[]` rather than throwing —
  the behaviour both di reference pages already documented, and which an
  application composing no starter hits immediately.

  **`/healthz` does not gate `/readyz`.** Readiness removes a pod from its
  Service's endpoints, so failing it on a dependency several replicas share takes
  every replica out at once and turns a degraded system into an outage. The
  kernel reports; an operator decides what a `503` there means.

  `@btravstack/mailer` contributes no check: its port offers only `send`, and a
  probe that delivers mail is not a probe. A cheap `verify()` belongs to the SMTP
  adapter, and can be added there without changing this shape.

  `PrismaLike` now requires `$queryRaw` — every generated Prisma client has it,
  and the check needs the server to answer something rather than trusting a
  pooled client's idea of "connected".

- b905a31: A starter offers its OpenTelemetry instrumentation; composing `otel()` registers it.

  `@btravstack/core` declares an `Instrumentations` set port. A package
  contributes a loader, `() => Promise<unknown>`; `@btravstack/observability/otel` loads every
  contribution and hands it to the `NodeSDK`. Composing a starter **declares**
  what can be instrumented, and composing `otel()` is what turns it on — the
  Spring Boot starter shape, in one port.

  `@btravstack/prisma` is the first contributor. Engine tracing used to be
  enabled while the client was built, whether or not an SDK existed; it is now
  offered, so a graph with no `otel()` never loads `@prisma/instrumentation` at
  all.

  **This does not weaken the preload rule.** `@opentelemetry/auto-instrumentations-node/register`
  still has to be preloaded before the libraries it patches are imported, and no
  provider can promise that. The rule was always about instrumentations that
  patch module loading — one whose `enable()` sets a helper the library reads per
  call has no such ordering requirement, and those are what `otel()` registers.

  `load` is async and answers `undefined` rather than failing, because the
  package supplying the instrumentation is an optional peer the consumer may not
  have installed. The contributor logs the skip, since it is the one that knows
  why.

  `otel()` contributes a member of its own that loads nothing — a collector
  depending on a set port nothing provides is an unmet dependency both at plan
  time and in `Needs`, and Guice's `newSetBinder` declares the empty set for the
  same reason.

  `Tracer` leaves `@btravstack/prisma`'s instrumented `needs`. It was there for
  ordering, to get the SDK up before the instrumentation was enabled; the SDK now
  does the registering, so the ordering is inherent. `Meter` still orders the
  client after `otel()`.

## 0.5.0

### Minor Changes

- c118a74: Raise the published Node floor to `>=22`, and use `Promise.withResolvers`.

  Node 20 reached end of life on **2026-04-30**. Every line that still receives
  security fixes — 22, 24, 26 — satisfies `>=22`, so this drops a promise rather
  than a supported runtime.

  **The old floor was never provable.** CI runs the dev toolchain, and pnpm 11
  needs `node:sqlite`, which Node 20 does not have — so no job here could ever
  execute the line `>=20` named, and `ci.yml` said so in a comment. The new floor
  sits on the same major as the matrix's `22.22` row, so the promise is exercised.

  The knock-on is `@btravstack/core`'s: `createDeferred` was an eight-line shim
  for a primitive the platform ships as `Promise.withResolvers`, held back only
  by the floor. It is gone, along with `src/deferred.ts`. `Deferred` was never
  exported, so no public surface moves — the only visible change is the
  `engines` field.

  `packages/core` raises its `lib` to `ES2024` for this, alone in the repository
  and commented where it happens; the shared `@btravstack/tsconfig` base stays on
  `ES2023` until a second package needs otherwise.

## 0.4.0

## 0.3.0

### Minor Changes

- e8236b2: Let a contract declare that a procedure requires an authenticated caller, and
  give `@btravstack/http-server` what it needs to satisfy that declaration.

  **The contract says which schemes protect a route; the application says what
  each one resolves to.**

  `@btravstack/contract` is a new zero-dependency package holding the marker
  itself, applied to a finished procedure or to a whole record of them. It
  names no identity type at all, so nothing about a server's view of a caller
  reaches a client. It returns the node unchanged — the marker lives in a
  `WeakMap` off `globalThis` and a phantom type key — so a client can import a
  marked contract without pulling in anything that implements it. `IsMarked<T>`
  answers the yes/no at the type level, `isAuthenticated(node)` reads the
  requirements back at runtime. An
  unmarked procedure is public; the marker makes the requirement legible in the
  contract rather than detecting one that was forgotten. Its full shape — the
  curried `authenticated(...requirements)(node)`, scopes and per-procedure
  overrides — is in the _named security schemes_ entry.

  `@btravstack/http-server` resolves the principal before dispatch, through an
  authenticator per scheme. A contract that marks nothing needs none; a marked
  router whose graph provides none carries that scheme's port as an
  unmet need `start` refuses. A marked procedure whose
  authenticator declines is answered `UNAUTHORIZED` before dispatch, with the
  handler never running and no reason reaching the caller — `Unauthenticated`
  carries none, so an authenticator logs why before returning.

  `http()` and `HttpModule` also gain `plugins`, forwarding oRPC handler plugins
  (CORS, body limits, compression, CSRF) straight to `RPCHandler`, and
  `securityHeaders`, applied on the node listener rather than as a plugin so the
  runtime's own `404` is covered too. `plugins` is an honest escape hatch rather
  than a keyhole — an oRPC plugin's `init` can reach the handler's interceptors —
  but the ordinary path is configuration visible at the composition root, not a
  middleware slot for application logic.

- 6f964fa: A module declares what its own providers expect from outside

  `Module(name)({ … })` takes a fourth list, `needs`. A port **this module's own
  providers** read, and that nothing here satisfies, must be named there; anything
  they owe and it does not name is refused at that call, with the port in the
  message:

  ```
  Property '"UNDECLARED NEEDS — name it in `needs`"' is missing in type
    '{ provides: [...]; exports: [...]; }' but required in type
    '{ readonly "UNDECLARED NEEDS — name it in `needs`": Logger; }'.
  ```

  Before this, a need nothing local satisfied simply travelled to whoever
  composed the module, and a composition root could satisfy an imported module's
  dependency without that module ever mentioning it — measured: a slice's
  provider received the root's service while importing nothing at all. A slice
  directory could not be read on its own.

  `needs` is the explicit stand-in for NestJS's `@Global`, which this container
  does not have and now does not need: the port is named, the supplier is not, so
  the slice still composes into any root that answers it.

  **An import's own needs are not the importer's to re-declare.** They are already
  published in the import's type, and the entry point still refuses a root that
  has not discharged them — so the declaration lands on the feature that reads the
  port, once, rather than on every module between it and the root. That is
  `ConfigModule.forFeature`'s shape reached without a global: `DatabaseModule`
  says `needs: [Env]` because it reads `DATABASE_URL`, and the persistence modules
  and slices that import it say nothing.

  `Scope` is exempt — nothing can provide it, and the entry point discharges it.

  The three starter sugars — `HttpModule`, `AmqpModule`, `TemporalModule` — take
  `needs` too and re-declare the gate over their augmented tuples, so a
  composition root written with a sugar is checked exactly like a bare
  `Module(name)`.

  `@btravstack/di` additionally exports `NeedsGate` and `Unmet`, which a package
  offering its own shaped module needs in order to re-declare the gate.

- 54de3fa: Let a contract name **which security schemes** a procedure accepts and **which
  scopes** each must grant, and let an application say what each scheme resolves
  to — in one call.

  `@btravstack/contract`'s marker carries OpenAPI's own requirement shape instead
  of a boolean. `authenticated` is now **curried**:
  `authenticated(...requirements)(node)`, where a `Requirement` is
  `Readonly<Record<string, readonly string[]>>` — a scheme name mapped to the
  scopes it must grant, and **exactly one scheme**: a second key does not
  compile, because OpenAPI reads two keys in one requirement as AND while this
  starter walks them as OR, so a requirement copied out of an OpenAPI document
  would silently execute a weaker rule than the one it states. Several
  requirements are **ORed**, tried in declaration order. Applied to a record it is the default for every procedure beneath it;
  applied to a procedure it **replaces** that default for itself — nearest mark
  wins, which is OpenAPI's rule. `isAuthenticated(node)` answers
  `Requirements | undefined` rather than a boolean, `Authenticated<T, R>` and the
  new `RequirementsOf<T>` carry the exact requirements at the type level, and the
  registry is a `WeakMap` under `Symbol.for("@btravstack/contract/requirements")`
  — a new key, so a mismatched copy of the package reads a node as _unmarked_ and
  fails closed rather than calling `.has()` on it and getting an accidentally
  correct answer.

  `@btravstack/http-server` gains **`defineHttp`**, the one door:

  ```ts
  export const api = defineHttp({
    authenticators: { user: userAuth, service: serviceAuth },
  });
  ```

  It hands back `HttpController`, `HttpRouter` and `authenticators`, all typed by
  a scheme registry **inferred from the authenticators** rather than declared a
  second time. Declaring a scheme and implementing it are the same act, so a
  scheme without an authenticator is not a state the API can reach. Hold the
  result as **one binding and never destructure it**: each destructured member
  expands to a type mentioning `@btravstack/contract`'s inaccessible
  `unique symbol` (TS2527), while held whole it collapses to the nameable
  `Http<A>` — so an application writes **no type annotation at all**, which is
  what removed the three hand-written ones the previous shape required.

  **The principal follows the requirements.** A leaf whose requirements name one
  scheme gets the identity **bare** — byte-for-byte what handlers wrote before.
  A leaf naming several gets `{ scheme, identity }`, narrowed with a `switch`
  whose missing arm is a compile error. A public leaf gets `never`, so reading it
  cannot compile.

  **Scopes are declared in the contract and enforced before dispatch.**
  `HttpAuthenticator<P, Scope>()` states a scheme's scope vocabulary, so a
  credential reports what it actually granted through the new
  **`granted(identity, scopes)`** (`Granted<P, Scope>` is `P` bare when there is
  no vocabulary, and the branded `Grant<P, Scope>` when there is one) and the
  starter compares it against what the endpoint declared: a valid credential lacking a required scope is **`403`**,
  no valid credential at all is **`401`**, and neither carries a message. A
  `Defect` from an authenticator short-circuits rather than falling through to
  the next scheme — a broken verifier must not promote every caller. `granted()`
  is **mandatory rather than advisory**: the type parameter is erased at
  runtime, so the module-private symbol it stamps is the only sound way the
  starter can tell a scoped answer from an identity that merely carries a
  `scopes` field — the ordinary JWT-claims shape, which a structural test read
  as the scoped answer and handed the handler `undefined`.

  A router now declares **one di dependency per scheme its contract names**, on a
  port whose id carries the scheme name (`HttpAuthenticator:user`), so a missing
  authenticator is di's own unmet need naming that port. `HttpModule` wires the
  authenticator providers itself, off the router that carries them.

  **Breaking.** The top-level `HttpRouter` export is gone — it comes off
  `defineHttp` now, because that is where the registry that types it is stated;
  so do `HttpController` and `HttpAuthenticator`'s applied form. Also removed:
  `httpAuth`, `HttpAuth`, `HttpControllerOf`, `HttpRouterOf`,
  `HttpAuthenticatorOf`, `AuthenticatorPort`, `noAuthenticator`, the
  `HttpModuleOptions.authenticator` option and the router/authenticator identity
  comparison it carried. `authenticated(node)` must become
  `authenticated({ scheme: [] })(node)`.

  **Not modelled, deliberately.** AND within one requirement — a requirement
  names one scheme, because requiring two credentials at once would put a record
  rather than an identity on the handler; a composite scheme models it where it
  is genuinely needed. And OpenAPI document metadata (`type: http`,
  `bearerFormat`, an OAuth flow), which belongs beside the contract rather than
  in this factory.

- b8fdee9: The `Unmet` type is gone from `@btravstack/di`

  Its documented purpose — a shaped module re-declaring the gates with it — was
  impossible to serve: declaration emit keeps the alias unreduced, and the
  unreduced form names imported modules' internal ports (TS2883 on the first
  consumer that exports a composition root), which is why every in-repo sugar
  already inlined the computation instead. Inline it; `NeedsGate` is unchanged
  and still exported.

  Internal trims alongside, none of them surface: `@btravstack/http-server` no longer
  memoises scheme ports (di resolves by id, so a fresh class per call is the same
  lookup — measured), and `HasMark`, `authenticatorPort` and `Http.authenticators`
  now carry TSDoc naming the external consumer each exists for, so their lack of
  an in-repo caller stops reading as dead surface.

- d5be140: `Runtime.needs` is `Runtime.resolves`

  Two different `needs` in one framework was one too many. di's `Module` has a
  `needs` — what a composition root supplies it — and the kernel's `Runtime` had
  one too, meaning something else entirely: the ports the runtime reads back out
  of the built application context. They never appear in the same object, which
  is exactly why the collision was easy to miss and easy to misread.

  ```ts
  const runtime: Runtime<typeof Clock> = {
    name: "ticker",
    resolves: [Clock],
    start: (host) => OkAsync(serving),
  };
  ```

  The type parameter is `Resolves` rather than `Needs` throughout —
  `Runtime<Resolves, Info>`, `RuntimeHost<Resolves>`, `RunUnit<Resolves>` — and
  `start`'s gate sentence follows:
  `"UNSATISFIED RUNTIME PORTS — the runtime resolves a port the module does not export"`.

  Every shipped runtime declares `resolves: []`, so an application that composes
  `http()` / `temporal()` / `amqp()` and never writes a runtime by hand is
  unaffected. A **hand-rolled** runtime renames one field.

  The array is still never read at run time — it exists so `Resolves` is
  inferable from the value, and `start`'s gate checks it against the module's
  exports.

- 3bf4036: A contract may name a scope only if its scheme can grant it

  `HttpRouter(contract)` now refuses a contract declaring a scope outside the
  vocabulary its scheme's authenticator was minted with, and the diagnostic ends
  on the offending scope:

  ```
  Property '"UNGRANTABLE SCOPE — its scheme's authenticator cannot grant it"' is
    missing in type 'Authenticated<…, [{ user: ["order:export"] }]>' but required
    in type '{ readonly "UNGRANTABLE SCOPE — …": "order:export"; }'
  ```

  Before this, nothing tied a contract's scope **strings** to what a scheme could
  actually grant. A typo — or a scope asked of a scheme declared with no
  vocabulary at all — compiled, passed every check, and then refused every caller
  on that route with a permanent `403` and no diagnostic anywhere.

  A requirement naming no scopes costs nothing, which is the common case. The
  check is the sibling of the scheme-**name** check di already performs by leaving
  an unknown scheme's port unmet.

### Patch Changes

- 4499df1: A comment earns its line, or it goes

  A quarter of the TypeScript in this repository was comment, and one line in ten
  an inline essay — so a reader looking for the code had to skim past the reasons
  for it. `CLAUDE.md`'s "comment density: sparse" bullet now carries a test: a
  comment earns its line only if it guards a specific line against a plausible
  "simplification", states a symbol's contract as TSDoc, is a directive with a
  reason, or is a `GIVEN`/`WHEN`/`THEN` marker.

  No API changes. What consumers see is the TSDoc these packages ship in their
  declarations: shorter, and stating each symbol's contract rather than the
  history behind it, which lives in the repository and on the documentation site.

- fc38b9a: The README samples compile again — and now cannot stop. Every `ts` fence in
  the package READMEs, the root README and the documentation site is extracted
  into generated type-test modules and compiled by `pnpm typecheck`. The sweep
  that built the gate fixed the drift it found: the amqp and temporal READMEs'
  two-argument `execute` from before the branded tenant, a wrong consumer key,
  a missing error-triage arm, and the pre-`defineHttp` router spelling in the
  root README.
- 31f70f7: The repository is `btravstack/btravstack`, so every package's `homepage`,
  `bugs.url` and `repository.url` points there. GitHub redirects the old slug, so
  nothing was broken — but published metadata that names a repository should name
  the one it lives in.
