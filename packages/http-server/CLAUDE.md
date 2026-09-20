# packages/http-server

The HTTP starter's decisions, gotchas and deliberate exclusions. The root
`CLAUDE.md` is the authoritative spec for the kernel and the conventions; this
file holds what only matters when you are working under `packages/http-server/`.
The surface itself — every signature, option, export and inject — is
`docs/reference/http-server.md` and the source TSDoc behind it; the doc-samples
gate compiles that page's `ts` fences and `README.md`'s. The authentication half
is `AUTH.md`. Keep this file in sync with the code in the same commit.

## Decisions and gotchas, by surface

- **`HttpModule(name)({...})`** (`http-module.ts`) — THE way an application
  declares an HTTP deployment. What it takes, what it adds to `imports`,
  `provides` and `exports`, and which providers `router` and `fragments`
  accept are in the reference page; what follows is what that page does not
  argue.
  `fragmentsPrefix` and `fragmentsLogin` are named for the fragment answerer
  alone: one field cannot carry two mounts with two different defaults, and a
  bare `login` would read as covering the oRPC half, which redirects nothing.
  **Both are forwarded field by field, and that is the one place this sugar's
  "an option it forgets to forward cannot exist" is not structurally true** —
  `httpServer`/`orpc` take the whole options record, `htmx()` cannot, because
  its two fields are named differently here than there. Adding an `HtmxOptions`
  field means adding a line to this call.
  The augmented tuples — `Imports<I>` / `Provides<P, Router, Fragments>`,
  readonly and exact — go to di's own `Module(name)({...})`, whose
  return type IS the sugar's: nothing spelled twice. di exports `AnyModule`,
  `AnyProvider` and `Exportable` for exactly that (constraining the tuples the
  way `Module(name)` does); its other module-typing pieces stay internal.
  (Spelling the return through a named generic alias was tried and removed:
  declaration emit keeps such an alias unreduced and cannot name imported
  modules' internal ports — TS2883, measured.)
  **There is no `authenticator` option.** Each router/fragments provider
  carries `readonly authenticators: readonly Auth[]` — the per-scheme
  providers `defineHttp` bound — and the sugar spreads them into `provides`
  itself, so an application never lists one and cannot list the wrong one.
  `Provides<P, Router, Fragments>` is a union-element **array**, not a tuple —
  an authenticator union is one type per scheme, and a tuple takes one rest
  element, not two. Nothing downstream wants the arity — di reads
  `P[number]` throughout — and putting the authenticators in `provides` is what
  carries **their own needs** (a `JwtVerifier`, a key set) into `NeedsGate`, so
  a root that satisfies none is refused at THIS call exactly as a hand-listed
  provider would be (`auth.test-d.ts`'s arms 11 and 12). A scheme the contract
  names that the registry has no authenticator for is di's own unmet need on
  `HttpAuthenticator:<scheme>`, not a gate this package writes — and the
  identity comparison the old `authenticator` option performed is gone with it,
  since declaring a scheme and implementing it are now the same act.
  **`ServesNothingGate` refuses the call when both `router` and `fragments`
  are omitted**, against
  `{ readonly "SERVES NOTHING — supply a router, fragments, or both": true }`
  — booting a listener with no answerer behind it is refused here rather than
  left to `start`'s own runtime gate.
- **`OrpcRouterPort`** (`orpc.ts`, exported from the file for the package's
  own tests, **not** from `index.ts`) — the router's port, one id, the
  starter's own: `Port("OrpcRouter")` cast to di's `PortClassOf<"OrpcRouter",
Router<Record<never, never>>>`, with the matching `PortInstance` alias. A
  process serves one router as it boots one runtime (thesis #1), so there is
  nothing to name, and the port is framework-owned like `HttpConfig` and
  `HttpRuntime`; two router providers in one graph are di's duplicate-provider
  defect at build, which is correct. The service type is contract-agnostic
  (a context-free oRPC router), so this is one concrete port — unlike the
  temporal and amqp starters', which are typed per contract.
- **`api.OrpcRouter(contract)({ inject: deps, sync })`** (`orpc.ts`, minted by
  `defineHttp`) — contract-first
  router provider. `Implementation<C, Schemes>` is the record type: recursing the
  contract's shape, each `ProcedureContract<I, O, E>` becomes
  `Parameters<ProcedureImplementer<DefaultInitialContext & object, ContextOf<C, R, Schemes>,
I, O, E>["result"]>[0]` — the `.result()` handler `@unthrown/orpc` gives that
  procedure's implementer (`import "@unthrown/orpc/extensions/result"` here;
  `@orpc/contract` and `@unthrown/orpc` are peers for it) — so `sync`'s return
  is typed by the contract at the call. At runtime `implement(contract)` is
  walked next to the record (`routerOf`: a function leaf → `node.result(fn)`,
  an object → recurse, a key the implementer has no node for — reachable only
  past the types — dropped rather than defected on; `implement()` returns
  `undefined` for an undeclared key, measured), and `os.router(built)` is the
  port's service. `C` is bounded `Record<string, RouterContract>` — a router
  record, not a bare procedure, since a bare procedure has no keys to walk. The
  second call is di's `Provider(OrpcRouterPort)({ inject: { name: Dep }, sync })` with the
  router built from what `sync` returns; there is no name to give. The
  return is `Provider<PortInstance<"OrpcRouter", Router<…>>, never,
InstanceType<D[keyof D]>> & { port: PortClassOf<"OrpcRouter", Router<…>> }`,
  spelled through di's `PortInstance` / `PortClassOf` (`{ portId; new ():
PortInstance<…> }`) rather than the class's own type because a class
  expression's type expands the brand keys in a consumer's declaration emit
  (TS4023, measured on `examples/order-api`) — which is also why
  `OrpcRouterPort` itself is a cast `Port("OrpcRouter")` and not a `class`.
  `provider.port` stays on the result for a hand-declared provider or a type
  test, and `provider.authenticators` carries the per-scheme providers
  `defineHttp` bound — on the router because the router is what needs them.
  An optional `unit: { name: Port }` beside `inject` declares what every leaf
  may read off `context.unit`, typed per leaf by its own kind — see
  **`context.unit` and `UnitFor`**.
  Only the `sync` arm: a router is built, not
  acquired. `HttpModule({ router: orderRouter })`, or `http()` next to
  `provides: [orderRouter]`, take it from there. Covered by the `rpc` fixture's
  `greetingRouter` (a bare-procedure `oc.router`, one nested) and the stray-key
  guard by `strayRouter` (the same implementation with an undeclared key,
  cast past the types).
- **`api.OrpcRouter(contract)([piece, …])` — the composing form** (`orpc.ts`, a
  third overload of `build`, declared **last**) — for
  `contract: Record<string, RouterContract>`, an **array of pieces** instead of
  `{ inject, sync }`, each an `OrpcController(contract, path)` over one node
  of the contract tree, at any depth — the same shape as
  `AmqpHandlers(contract)([...])` and `TemporalActivities(contract)([...])`,
  with the paths as HTTP's extra degree of freedom. Coverage is **leaf-based**:
  the paths must partition the contract's PROCEDURES (`LeafPathsOf`, each leaf
  covered when it sits at or under a piece's path — `CoveredBy`), so any mix
  of depths composes — `[v1Orders, v1Customers, health]` and `[v1, health]`
  alike. An uncovered leaf is refused against the
  `"UNCOVERED CONTROLLERS — the contract declares a procedure this array does
not cover"` marker, and what the marker names is a procedure path
  (`"v1.customers.find"`), not a fragment. Declared last is load-bearing
  (measured in `packages/amqp-worker`, same mechanism): TypeScript reports the
  last overload's failure, so a non-covering array fails against the marker
  rather than degrading to di's `Qualification`, which names nothing; the
  marker is a **sentence** because it is the only actionable part of the
  diagnostic and it prints last, past the caller's own wide piece type. The
  refusal is a tuple **as long as the array the caller wrote** — its head the
  caller's own elements, which match, and its last element the marker paired
  with the missing leaf — so TypeScript compares them element by element and
  reports one diagnostic, on the trailing element, naming both. It used to be
  a fixed two-element tuple, which named the leaf only when the array happened
  to be two elements long; at one or three the developer diffed the contract
  against the array by hand.

  A third rule rides the same overload and produces NO diagnostic:
  `Erroneous<T>`, which stands the gates down when an element's key is a
  **union**. A minted piece carries exactly one key; a piece whose mint was
  refused (`OrpcController(contract, "billing")` on a contract with no
  `billing`) is typed from the parameter TypeScript rejected, so its key reads
  as every valid path — a union containing both `"v1"` and `"v1.orders"`,
  which is exactly what `Overlapping` refuses. The array call then reported
  OVERLAPPING where nothing overlapped: first error right, loudest error
  wrong. Standing down costs nothing, since the mint's own `TS2345` — which
  lists every valid path — is already there.
  A **second gate** rides the same overload: `Overlapping<Paths>` — a piece
  path nested inside another piece's path
  (`Overlapping<"v1" | "v1.orders" | "health">` is `"v1.orders"`), refused
  against
  `"OVERLAPPING CONTROLLERS — a piece sits inside another piece's fragment"`.
  It must exist because the two pieces would implement the same procedures on
  **two distinct port ids** — unlike two pieces at ONE path, which share an id
  and are di's duplicate-provider defect — so di cannot see them conflicting,
  and the `nest` rebuild below would silently let one win. This gate is the
  only thing standing between a dotted path and that silent overwrite.
  `Uncovered` reads each piece's path by stripping `CONTROLLER_PREFIX` back
  off its port id (`KeyOfPiece`), so the path is never spelled twice; and
  `PieceOf`'s port type is spelled **inline**, not as
  `ControllerPortOf<C, K, Schemes>` — a regression guard against a hole that
  held only on #116's flat `ControllerKeyOf`; on the current recursive-path
  shape both spellings refuse the marked-piece-under-unmarked-contract
  direction (re-measured 2026-08-25, same TS version as #116). Kept anyway
  because the alias route rides a compiler heuristic that has already changed
  behaviour across one key-shape refactor — see `PieceOf`'s own TSDoc. At
  runtime `Array.isArray`
  alone identifies this arm — an array is never a valid `{ inject, unit?, sync }`
  call — so the retired keyed record's three-form
  `sync`-holds-a-function discrimination is gone, and there is nothing left to
  discriminate: the other arm is one options object, as di's own is. The
  composed provider's `deps` are the piece
  **ports**, keyed by the very dotted path each port id carries — so di
  builds every piece before the router, and `nest` folds the flat path-keyed
  services record back into the nesting the contract already has before
  `routerFrom`: `routerOf` walks the same tree it always did, marks,
  inheritance and the stray-key drop included. The walk itself is untouched —
  `nest` lives in the composing arm because the walk is shared with the
  `{ inject, unit?, sync }` form, which never nests. The pieces themselves still need
  discharging — listed in `provides` alongside the router, or exported by a
  slice module imported in — exactly as in `packages/amqp-worker`. Coverage
  is not uniqueness, but with paths the split moved: a piece **inside**
  another piece's fragment is caught at the call (the
  `OVERLAPPING CONTROLLERS` gate above), while two pieces at the **same**
  path remain one port id and therefore di's duplicate-provider defect — and
  only when **both** end up discharged as providers in the same graph; wire
  in only one and the other's implementation is simply never registered, no
  diagnostic marking the conflict.
  **A literal dot in a contract key is refused, at both ends** (issue #121,
  where it was a green compile and a 404): `nest` rebuilds a piece's path by
  splitting on `.`, so it cannot tell a path separator from a dot inside one
  key. `ControllerKeyOf` therefore drops dotted keys at **every** level, so
  no port can carry one — but the **mint** is constrained by `AnyKeyOf`, the
  same walk without the refusal, with `SliceableGate<C, K>` intersected onto
  `key` the way `ScopeGate` rides `contract`. That is the difference between
  a diagnostic that says why and one that misleads: constraining `key` by
  `ControllerKeyOf` refuses `"a.b"` too, but as
  `not assignable to parameter of type '"plain"'` — a typo hint pointing at
  the wrong problem. The gate binds the bad path instead and names it in a
  sentence. On the array, `Unsliceable<C>` refuses a contract whose **top**
  level carries one, against `"UNSLICEABLE CONTRACT KEY — …"` reported ahead
  of `Uncovered`, because "no piece can name this" is a different fact from
  "no piece did" and only the first says the array form is the wrong tool.
  Both sentences point at the `{ inject, unit?, sync }` form, which splits nothing and
  serves such a contract correctly. Only the **top** level is fatal: a piece
  at a dotted key's parent hands its implementation record to `routerOf`
  whole, and that walk splits paths, never the keys underneath them — so
  `{ v1: { "a.b": oc } }` still composes from a piece at `"v1"`, and the gate
  must not over-reach onto it.
  The return is the same `Built<Auth, N>` as the other arms, with
  `N = InstanceType<T[number]["port"]> | SchemePortsOf<C>`.
  Six compile-time gates are pinned by `controller.test-d.ts`: every
  procedure covered (the marker above); an undeclared path refused **at the
  mint** (`OrpcController(contract, "billing")` and `(deep, "v1.billing")`
  have nothing to type the key by — the keyed record's `"UNDECLARED KEY — …"`
  gate collapsed into it); a piece under the wrong key impossible **by
  construction** (its path rides its port id, so what that gate refused is
  now an array leaving a leaf uncovered — the same marker, pinned as its own
  arm); a procedure the fragment does not declare rejected inside the piece;
  and — the fifth, marked "do not break" — a slice lifting out of the
  composed router **with its piece unchanged**:
  `api.OrpcRouter(contract.orders)({ inject: { implementation: ordersPiece.port }, sync: ({ implementation }) => implementation })`
  compiles, so the lifted root declares the very provider the modulith
  composed and hands back what it built; and the sixth, a top-level key
  carrying a literal dot, refused at the mint and again at the array. The
  gate names the piece
  deliberately — a fresh `sync` literal over the fragment would pin only that
  a fragment is a valid contract, the weaker half, which says nothing about
  the piece surviving the lift. All five are pinned **twice**: once against a
  plain contract and once against one whose `orders` fragment is
  `authenticated({ user: [] })(...)`, so the marker's phantom key cannot
  quietly break any of them — the fifth least of all. The same block pins the
  one direction that must be refused: a piece whose handler reads
  `opts.context.principal` cannot be composed under the **unmarked**
  contract, where nothing would inject one (the arm the inline `PieceOf`
  spelling exists to keep firing). The reverse is accepted and correctly so —
  a piece over an unmarked fragment inside a contract that marks another is a
  handler that ignores the principal, which is contravariantly fine.
  Three further arms pin what the requirements themselves do: a procedure
  under a marked record inherits that record's requirement, a procedure with
  its own mark **replaces** it rather than adding to it, and the router's needs
  channel carries one `HttpAuthenticator:<scheme>` port per scheme the contract
  names anywhere — two schemes, one scheme, and none at all, each asserted in
  **both** directions, since a one-way check passes on a collapsed `never`.
  The depth block at the file's tail pins the dotted paths themselves: pieces
  at mixed depths partitioning the leaves compose, an uncovered procedure and
  a nested piece are each refused against their marker, and the port id
  carries the whole path (`"OrpcController:v1.orders"`).
  Covered at runtime by the `rpcSliced` fixture — `helloController` over
  `slicedContract`'s `greetings` fragment and `echoesController` minted by
  the DOTTED path `"echoes.ping"`, so `nest`'s rebuild answers a real
  request — and by `rpcDeep`, two pieces sharing the nested `"v1"` parent
  plus one at the bare procedure path `"health"`.

- **`api.OrpcController(contract, key)({ inject: { name: Dep }, sync })`, or
  `({ inject: {}, sync })` with no deps** (`controller.ts`, minted by
  `defineHttp`) — one
  node of a contract, at any depth, as a provider on a port of its own. There
  is no name to give: the dotted path IS the port's name, minted as
  `` `${CONTROLLER_PREFIX}${key}` `` (`CONTROLLER_PREFIX = "OrpcController:"`,
  exported from `controller.ts` only) — the move `AmqpHandler(contract, key)`
  and `authenticatorPort(scheme)` both make. The port id carrying the path is
  what makes two slices claiming one node di's duplicate-provider defect
  rather than a silent merge, and what lets the composing form recover each
  piece's path without it being spelled again. The first call fixes the
  contract's type — read for its **type** only, so a path the contract does
  not declare is refused at the call (`ControllerKeyOf<C>`, the union of
  **every path** into the contract tree — a fragment or a procedure, dotted
  at each level, less the marker's phantom key; the former top-level keys are
  its depth-1 subset). Two guards inside are measured, not stylistic: an
  index-signature record short-circuits to `string` — that shape is only ever
  a GENERIC's constraint (`RouterContract` is recursive), and recursing over
  `string` keys was TS2589 at every generic declaration whose constraint
  mentions the type — and `Implementation`'s first parameter is **unbounded**
  for the sibling reason: it is instantiated with the deferred
  `FragmentAt<C, K>`, whose branches TypeScript cannot prove `RouterContract`
  for a generic contract, while the mapped arm already guards each child with
  `C[K] extends RouterContract`. A procedure the fragment does not declare or
  a handler whose input or output has drifted is a compile error inside the
  piece rather than at the root. The fragment's type is `FragmentAt<C, K>`,
  applied **at the mint**: it folds `Effective` down the path — nearest mark
  wins at each level, exactly the step `routerOf`'s `inherited` argument
  takes at runtime, so the types and the walk cannot part — and ends on
  `Inherit<node, folded>`, which is how a marked ancestor types
  `context.principal` in a piece minted from below it — the check the retired
  keyed form performed at the root, now performed where the handler is
  written. The second call is di's `Provider(port)({ inject: { name: Dep }, sync })`,
  unchanged — **`inject` included, and required**: a piece that calls no use
  case is the common shape here, not an edge case, and it spells
  `{ inject: {}, sync }` like every other no-deps provider (issue #227). An
  optional `unit: { name: Port }` rides beside it — see **`context.unit` and
  `UnitFor`**.
  Returns
  `Provider<InstanceType<ControllerPortOf<C, K, Schemes>>, never, N> & { readonly port: ControllerPortOf<C, K, Schemes>; readonly unit: U }` —
  `ControllerPortOf<C, K, Schemes>` being `PortClassOf` over the prefixed
  path and `Implementation<FragmentAt<C, K>, Schemes>`, the same
  `PortInstance`/`PortClassOf` spelling `OrpcRouter` uses and for the same
  reason (TS4023 on a class expression's own type). `ControllerKeyOf<C>` and
  `ControllerPortOf<C, K, Schemes>` are **types**, exported from `index.ts`
  for the same declaration-emit reason `@btravstack/amqp-worker` exports
  `HandlerPortOf<C, K>`: a slice module that exports its piece by name needs
  the port type printable. The piece does no oRPC work: it is a plain record;
  `OrpcRouter`'s `routerOf` walk is what wraps a leaf in `.result(...)`, at
  composition. A slice's module exports `controller.port` rather than naming
  a port of its own — the shape `Config.provider("RelayConfig")(schema)`
  already uses in this repo. Covered by `controller.spec.ts`'s `controllers`
  fixture (the key-minted port and declared deps a piece carries) and by
  every gate in `controller.test-d.ts` above. `controller.ts` imports
  `Effective`/`Implementation`/`Inherit` from `orpc.ts` with `import type` —
  erased by `verbatimModuleSyntax` — while `orpc.ts` imports
  `CONTROLLER_PREFIX` from `controller.ts` as a value, so the two files
  reference each other in the type graph with **no runtime cycle**, the same
  arrangement `packages/amqp-worker` documents between `handler.ts` and
  `amqp-runtime.ts`.
- **Authentication — the contract marker, `Principal`/`SchemesOf`,
  `HttpAuthenticator`, `defineHttp`, `resolvePrincipal`, `principalMiddleware`,
  the scope rule and the scheme-dependency wiring — is stated in full in
  `AUTH.md`.** Read it
  before changing `auth.ts`, `principal.ts`, `define-http.ts` or the contract
  marker. In short: the contract says WHICH SCHEMES protect a route and which
  scopes each must grant, `defineHttp({ authenticators })` says WHAT each
  scheme resolves to, and an unmarked procedure is public with nothing failing
  if the marker is forgotten. `AUTH.md` also covers the shipped authenticators
  (`apiKeyAuthenticator`, `jwtAuthenticator`), the session scheme and `oidc()`.

- **`html`/`raw` and `Html`** (`html.ts`) — a tagged template escaping every
  interpolation by default: `` html`<tr>${value}</tr>` `` HTML-escapes
  `value`, a nested `Html` splices unescaped (once, not twice), and an array
  concatenates with no separator. `Html` is an **object**,
  `{ [HTML]: true, value: string }`, keyed on `Symbol.for` rather than a bare
  `unique symbol` — two copies of this package would otherwise read each
  other's fragments as untrusted strings and escape them twice. `raw(markup)`
  is the one way past the escaping, a visible act at the call site.
  **The escaping is context-blind**: it protects element text and a quoted
  attribute value, and nothing else — an unquoted attribute, an attribute
  name, a URL scheme (`href="${url}"` does not vet `javascript:`), and
  `<script>`/`<style>` contents are the caller's own responsibility, stated in
  `html`'s own TSDoc.
  **oxfmt and prettier reflow a tagged template named `html` as embeddable
  markup**, inserting real whitespace into rendered output — this repo sets
  `embeddedLanguageFormatting: "off"` for exactly that reason, and a consuming
  application must do the same or its output drifts silently the moment a
  formatter runs.
- **A fragment route declares itself; there is no contract kind for it.**
  `defineFragments`, `FragmentRoute`, `FragmentsContract` and
  `api.HtmxController(fragments, key)` are **deleted** — `htmx-route.ts`
  carries only the route-first mint below.
  The decision: **a contract earns a package when a client consumes it**. An
  oRPC procedure gets `@orpc/contract` because `@orpc/client` reads the same
  object to build a typed call, and a Temporal or AMQP contract gets its own
  package for the identical reason — a client on the other side needs the
  shape without the server. A fragment route has no client: a browser
  navigates to a URL and htmx swaps the response into the DOM, so there is
  nothing on the other end that would ever import `FragmentsContract`. Its
  declaration therefore lives with its implementation, exactly where a route
  handler already is, rather than in a contract package earning its keep for
  no consumer. The test cuts both ways: GraphQL's SDL **is** client-consumed
  (a codegen tool, a typed client), so it gets a contract package when it
  lands, on the same criterion this one failed.

  This also closes a tension a contract shape declared here would carry:
  `defineFragments` was a one-line identity function whose only import was a
  _type_, yet declaring it in this package would mean a client-only package
  importing it purely for the fragment shape also peers on this package's
  whole oRPC server stack — exactly what "a client must be able to take a
  contract without the server" (root `CLAUDE.md`, thesis #1) exists to
  prevent. `examples/order-api-contract` carries no such peer: with no
  contract shape here, there is nothing to import it for.

- **`api.HtmxGet(path, options?)` and `api.HtmxPost(path, options?)`**
  (`htmx-route.ts`, minted by `defineHttp`) — a route as a provider on a port
  of its own, minted straight from a path template, then `{ inject, sync }`
  — `inject: {}` when the route calls nothing — the same two-call shape as
  `api.OrpcController(contract, path)`. The port id carries the method and
  path (`` `HtmxFragment:${method} ${path}` ``, `FRAGMENT_PREFIX` in
  `htmx-route.ts`) — two routes on one method and path are one port id, di's
  duplicate-provider defect. `options.requires` is any `Requirements`,
  intersected with `RequiresGate<R, Vocab>` — `orpc.ts`'s `ScopeGate` with the
  contract fold removed, since `requires` is data rather than a tree to walk
  — so a scope the scheme's authenticator cannot grant is refused at the mint
  against the same `"UNGRANTABLE SCOPE — its scheme's authenticator cannot
grant it"` sentence oRPC's `routerFor` gives — and each requirement is also
  intersected with `@btravstack/contract`'s `OneScheme`, the same constraint
  `authenticated()` carries, so a two-scheme requirement (OpenAPI's AND, which
  `resolvePrincipal`'s first-match walk would execute as OR) is refused at
  the same mint. Both checks run as far as `requires` survives as a narrow
  literal type: `const R` infers one from a literal at the call, and an
  `as const` value declared elsewhere keeps its scheme keys and scopes too,
  so both still bind. What escapes them is a value **widened** to
  `Requirements` — `requires` is data, so a widened one carries no
  compile-time checking either way, and the runtime walk in `auth.ts` is what
  remains. That is the trade for deleting the contract kind. `HtmxPost` additionally takes
  `options.input`, any Standard Schema over the decoded form body — the same
  shape `Config.provider` accepts, so no schema library joins this package for
  it — and `HtmxGet` has no `input` field at all, refusing a `GET` route that
  tries to declare one structurally rather than through a separate gate.
  `sync` returns `(context, params, input) => AsyncResult<Html, never>`:
  `params` typed from the path template's `:name` segments (`ParamsOf<P>`,
  `fragments.ts`), `context.principal` typed from `requires` exactly as an
  oRPC leaf's is, `input` typed from the schema or the raw decoded form when
  none is given. An optional `unit: { name: Port }` rides beside `inject`, and
  `context.unit` is that record narrowed to the kind the route's own
  `requires` selects — `KindOf<R>` read straight off the data, where an oRPC
  leaf reads the same kind off its contract's marks; see **`context.unit` and
  `UnitFor`**. The minted provider carries `.port`, `.route` (`method`,
  `path`, `input`, `requires`) and `.unit` — what the array arm below reads
  back to compose without the path or the requirement being spelled twice.

  ```ts
  const orderRow = api.HtmxGet("/orders/:id/row", { requires: [{ user: [] }] })({ inject: {}, sync: () => (context, params) => repository.find(params.id).map(rowOf) });
  ```

- **`api.HtmxFragments([piece, …])`** (`htmx-route.ts`, minted by
  `defineHttp`) — every route composed from an array of `HtmxGet`/`HtmxPost`
  pieces into one port, keyed by **index** rather than by the piece's own
  port id: two pieces sharing one method and path share one port id, and
  keying `deps` by that id would silently keep only the last, hiding the very
  collision di's duplicate-provider defect exists to catch. The key space has
  no tree to walk, so there is no uncovered-route or overlapping-piece gate
  to state — every piece in the array is composed, and the array's own order
  is the routes' order. Every scheme any piece's `requires` names is walked
  straight off that data (`schemesInRoutes`) — there is no contract marker to
  resolve, since a route-first `requires` is never marked, only ever data
  read straight off `piece.route`. The returned provider carries
  `readonly authenticators` the same way the router does, so `HttpModule` can
  read both and deduplicate a scheme shared between them by reference. The
  composed port, `HtmxFragmentsPort`, is unchanged: `{ routes: readonly
FragmentAnswer[], authenticators }`, where `FragmentAnswer.handle` erases the
  principal and the decoded input to `unknown` — the answerer's own concern,
  not the piece's.

- **`http(options)`** — the starter, and **oRPC's answerer under the HTTP
  runtime**: one protocol, over its own node adapter, contributing one member
  to the `HttpHandler` set port. Its signature, options, what it provides,
  exports and needs, `HttpConfig`'s variables and defaults, and `HttpInfo` are
  in the reference page. It used to be "the one way HTTP is answered here" and is not any more —
  see **Several answerers, one runtime** below. The
  former `@btravstack/orpc` was folded in for that reason — oRPC shares this
  stack's convictions (a contract, typed errors, `Result` at the boundary), so
  it is enforced, not offered among alternatives. The router is not an
  option: the module **needs** `OrpcRouterPort`, and the application provides
  it — a provider that declares the use cases its procedures call (di injects
  them, oRPC's context stays empty).
  `HttpConfig` is declared in `http-config.ts` rather than
  `http-runtime.ts` because `orpc.ts` reads it and `http-runtime.ts` imports
  `orpc` — a leaf module is what keeps that from being a runtime import cycle.
  Every field **pins** instead of reading — explicit >
  env > default, per field (`Config.pinned(value, field)` swaps the field's
  `parse` for a constant and keeps the variable name). A pinned field reads
  nothing from the environment; the declared `Env` need and `ConfigInvalid`
  stay whatever is pinned — one signature, no overload pair to keep in step
  (the kernel discharges the one, a pinned config never produces the other).
  There is **no fully-pinned shortcut provider** any more: it existed to skip
  the `Env` read when `port` and `hostname` were both given, and once the
  transport policies became config fields it would have been a branch nobody
  could satisfy — `Config.pinned` already reads nothing.
- **`cors`, `bodyLimit`, `compression`** — oRPC plugins as named options, each
  typed by the plugin's own options type per the passthrough rule; the types
  and variables are in the reference page.

  **Each SCALAR half is a field of `HttpConfig`, not a closure**, bound from
  `HTTP_BODY_LIMIT`, `HTTP_CORS_ORIGIN` and `HTTP_COMPRESSION` and **pinned** by the option —
  explicit beats environment beats default, per field, the same
  `Config.pinned` shape `PORT`/`HOST` already used. The option is what a test
  or a fixed decision pins; the variable is what a deployment sets. The
  SHAPE halves — a `CORSHandlerPluginOptions` record's headers and methods,
  `ResponseCompressionHandlerPluginOptions`'s `encodings`/`threshold`,
  `plugins` — stay composition-time and reach the handler through `orpc()`'s
  closure, because a record is not something an environment can carry.
  `orpc.ts`'s `pluginsOf(options, config, csrf)` is where the two meet, and the oRPC
  handler provider therefore declares `HttpConfig` as a dependency — which is
  why `orpc()`'s `HttpConfig` dependency is discharged by `httpServer()`
  rather than owed by `http()`'s own needs channel.

  Precedence, spelled once in `corsOf`: a record naming `origin` wins,
  `HTTP_CORS_ORIGIN` next, oRPC's own default (reflect the request's origin) last.
  `cors: false` pins `""` and is off whatever the deployment says; `HTTP_CORS_ORIGIN`
  alone is enough to turn CORS on, which is what lets a deployment admit a
  browser client without a code change. A comma-separated list becomes the
  plugin's own origin array, `*` included.

  **`bodyLimit` is the only one whose default is on** (`DEFAULT_BODY_LIMIT`, 1
  MiB): an unbounded body is a trust boundary, where CORS and compression are
  policy a framework guessing is worse than one staying quiet. Over the limit
  is oRPC's `PAYLOAD_TOO_LARGE`, decided on `content-length` when one is sent
  and while streaming otherwise. `bodyLimit: false` pins `0`, which is
  unbounded — the one value the environment can also carry.

  **`compression` is the RESPONSE half only.** `RequestCompressionHandlerPlugin`
  stays in `plugins`: inflating a body before the limit measures it is an
  application's decision to make in the open.

- **`csrf`** — a state-changing request that carries cookies must be
  same-site, refused with a bodyless `403` **before dispatch**, in the
  listener beside `securityHeaders` so it covers every answerer rather than
  only what oRPC matched. `POST`/`PUT`/`PATCH`/`DELETE` carrying a `cookie`
  header must present `Sec-Fetch-Site: same-origin` or `same-site`; where the
  browser sent no fetch metadata, an `Origin` naming the request's own `Host`.
  Nothing else — no token, no form field, no session state: this is the
  stateless check a stateless BFF can make.

  **The rule is "carries COOKIES", not "carries OUR cookie".** The listener
  does not know any scheme's cookie name — a second cookie-reading scheme is
  free to bring its own — and a check independent of that configuration is
  both the standard fetch-metadata recommendation and one such a scheme
  cannot silently widen. A request with no cookie
  at all is not checked: a caller presenting a bearer token or an API key
  rides no ambient authority, so it is not a CSRF target.

  **The `Origin` fallback compares HOST, deliberately not scheme.** Behind a
  TLS-terminating proxy the connection this process accepted is `http` while
  the browser's `Origin` says `https`, so a scheme comparison would refuse
  every real deployment. `__Host-session` is `Secure`, which is what keeps the
  cookie off the plaintext scheme instead. An `Origin` no `URL` can parse —
  `null`, from a sandboxed frame or a cross-origin redirect — is not the
  request's own host, and neither is an absent one: a cookie arriving with
  nothing at all saying where from is refused.

  **The default is a GRAPH fact, not an option default**: on when any composed
  surface reads a cookie, off otherwise. `sessionAuthenticator`'s description
  carries `cookie: true`, `defineHttp` turns that into a member of the
  `CookieSchemes` set port beside the scheme's own provider, and both the
  listener and `orpc()` read the set. A set port rather than a marker
  `HttpModule` folds off `router.authenticators`, because `http()` never sees
  an application's authenticators — the root composes them itself — so an
  options-only signal would leave that surface silently unprotected; a
  `ctx.get` at start could not answer it either, di's `Context` having no
  `has`. `httpServer` contributes the `false` member that keeps the set from
  being the empty dependency di refuses.

  **A cookie surface that is not a SCHEME contributes too, and forgetting that
  was the bug.** `oidc()` reads `__Host-oidc`, seals `__Host-session` and
  serves a state-changing `POST <prefix>/logout`, and it contributed nothing —
  on the argument that a session scheme composed beside it would turn the
  default on. A root composing `oidc()` and `sessionCodec()` with no
  `sessionAuthenticator` has no such scheme, still logs a browser in and still
  exposes the logout, so it ran with CSRF off. `oidc()` now answers TWO
  providers — the answerer and a `cookieScheme()` member — which is why a root
  spreads it. The rule to carry forward: **whatever reads or writes a cookie
  contributes, whether or not it is an authenticator**, because the set is what
  makes the default a fact rather than a line somebody remembered.

  **oRPC's `GetMethodCsrfProtectionHandlerPlugin` rides the same flag**, and
  the two halves are disjoint: the listener judges the state-changing methods
  and never sees a `GET`, the plugin judges the `GET` oRPC admits for an
  event-iterator procedure — the one preflight-free surface the listener's
  method set deliberately leaves alone. Nothing is refused twice. A fragment
  answerer needs no plugin: its `POST` is form-urlencoded, exactly the
  preflight-free shape, and the listener check is upstream of every answerer.

  **A refusal is an ANSWER, so it is tracked like one.** The `403` is written
  after `open.add(response)` and after `observe(...)` has started the request's
  operation, and only then — still before `host.run`, so no answerer and no unit
  ever sees it. Registering the tracking first is what keeps a refused request
  visible to the RED observers and to response tracking; writing it before
  meant a `403` that no metric counted and no span recorded, which is the one
  status an operator most wants to see a rate for.

  **`csrf` stays composition-time, and so does `securityHeaders`** — a
  deployment that can silently turn `x-frame-options`, or this check, off is a
  footgun the transport-policy options are not.

- **`plugins`** is an **honest escape hatch, not a keyhole**: oRPC's
  `StandardHandlerPlugin.init` transforms handler options **including
  `StandardHandlerOptions.interceptors`**, so a plugin can wrap execution and
  an application determined to see a procedure's outcome can get there. What
  the option buys is that the ordinary path is visible configuration at the
  composition root rather than a middleware slot for application logic —
  which is the one thing thesis #3 and the "Not included" bullet below still
  refuse, and reaching past it is a visible act rather than the default shape.
  `principalMiddleware` (see `AUTH.md`) is the one per-request hook this package
  itself installs, and only on a marked leaf.
- **`securityHeaders`** is **not** routed through `orpc()`: it is applied by
  `http-runtime.ts`'s `listen`, on the raw node listener, **before**
  dispatch. That placement, not an oRPC plugin, is deliberate: a plugin only
  runs for a request oRPC **matched**, so the runtime's own `404` and `500`
  would go out bare — the opposite of what helmet-style headers are for.
  Resolved once per `listen` call, outside the per-request `createServer`
  callback, and set as its **first** statement — before `open.add(response)` —
  so it covers a served response, the runtime's `404`, its `500`, and a
  drained/retired response alike. Its type, default and default header set
  are in the reference page.
- **Two gates, both compile-time, and they are different mechanisms.**
  `start`'s phantom marker — intersected onto `module` — turns
  a composition exporting no `HttpRuntime` into a `TS2345` whose last line is
  `"NO RUNTIME — the module exports no port declared over RuntimePort"`; and
  because the runtime provider depends on the router port **through di**,
  a composition that imports `http()` without providing the router
  carries `OrpcRouterPort` as an unmet need `start` refuses on the same
  parameter's `Module<X, E, Scope | Env>` half, ending on
  `Type '"OrpcRouter"' is not assignable to type '"@di/Scope"'`. Neither is
  di's `UNSATISFIED DEPENDENCIES` dependency gate.
  `examples/order-api/src/needs-gate.test-d.ts` pins both, plus a third —
  `HttpModule`'s own `unit.anonymous` needs-propagation gate, the same shape
  as the two workers' — now that the answerers-fork change (below) retired the
  kernel-level `StartOptions.unit` gate it used to show instead.
  **`UNSATISFIED RUNTIME PORTS` is live for this
  runtime again**: `HttpRuntime` resolves `HttpHandler`, so a root that does not
  export it is refused at `start` — `HttpModule` adds it to `exports` itself, and
  a hand-written root writes `exports: [HttpRuntime, HttpHandler]`.
- **What it decides.** A procedure under `prefix` answers with its output or
  the `ORPCError` the router's `.result()` triage mapped its `Result` to
  (`@unthrown/orpc`, in the application — this package maps nothing); a defect
  inside a procedure is oRPC's own `INTERNAL_SERVER_ERROR` collapse; a path
  under `prefix` naming no procedure, and any path outside it, is declined
  unwritten by oRPC's adapter (`{ matched: false }`) and answered by the
  package's own `404`. The other two fallbacks — `500` when the listener
  failed before headers were out, socket destroyed once they were — are
  unreachable over the oRPC surface and exist because the transport is proven
  against a bare listener. A defect that never reaches the listener's promise
  — a synchronous throw out of a bare `HttpAnswerer.handle`, before it ever
  returns a promise — gets its `500` from the unit's `recoverDefect`, which
  destroys the socket only once headers are already out. An answerer's own
  fork (below) failing to build never lands here: oRPC catches a middleware
  throw itself and collapses it to its own `INTERNAL_SERVER_ERROR`, before
  `recoverDefect` or even `answer` ever sees it, and `htmx()` writes its own
  `500` directly, through `refuse`.
- **oRPC decides an `ORPCError`'s wire STATUS from its `code`, and this
  package pins no map for it.** `orpc()` builds its `RPCHandler` with no
  `errorStatusMap`, so `@orpc/server` falls back to its own
  `COMMON_ERROR_STATUS_MAP` — a fixed dictionary of the standard codes — and a
  **custom** code outside it resolves to `DEFAULT_ERROR_STATUS`, `500`. The
  contract's own `status` field (an OpenAPI-handler concept) is never read by
  this handler. Two codes in the running examples hit this today —
  `INVALID_QUANTITY` and `CURSOR_SORT_MISMATCH`, both declared client-input
  errors that therefore answer `500` rather than a `4xx`, tripping any
  5xx-keyed retry or circuit breaker a caller has — and
  `examples/order-api/src/api.spec.ts`'s
  `"pins — does not endorse — the wire status CURSOR_SORT_MISMATCH gets today: 500"`
  test holds the current behaviour in place rather than the intended one. The
  fix is an `errorStatusMap` passed to `orpc()`'s `RPCHandler`: a
  starter-level decision, since it changes the status of every already-shipped
  custom code for every consumer, and has not been taken.
- **The guarantee**: the unit's lifetime **is** the response's — it does not
  close until the response's `'close'` event fires, and closes at once if that
  event already fired before the work ran — so
  there is no seam for a late write to land in, and `id: randomUUID()` is
  minted per request (an inbound `traceparent`'s trace id becomes `traceId`,
  else an inbound `x-request-id` matching `REQUEST_ID` — a bounded token, since
  the value rides every log line and every span, and a blank one would beat the
  minted id outright),
  so the two contracts a runtime owes are structural here rather than left to
  a caller's care.
- **The fork is the answerer's, for a request it handles — not the kernel's,
  and it is the KIND that decides which module.**
  `http()`/`httpServer()`/`HttpModule` all take
  `unit?: Readonly<Record<string, AnyUnitModule>>` — kind → module — provided
  on `HttpUnit` (`Port("HttpUnit")<Readonly<Record<string, AnyUnitModule>>>`,
  not exported from the package — reached the same way `OrpcRouterPort` is,
  never by name) and injected by both answerers. The kind is `anonymous` for a
  leaf that asked for no credential, else the SCHEME that resolved one:
  `resolveScheme` reports `{ scheme, identity }` on every success, and each
  answerer looks the module up by it — `units[kind] ?? units.anonymous`.

  **A scheme that binds no module of its own FALLS BACK to `anonymous`**, and
  nothing is forked only when neither binds one. A scheme's module is how one
  kind is SPECIALISED, not how the others are switched off: binding
  `{ anonymous }` alone has to keep forking on every leaf, exactly as it did
  before kinds existed. The alternative — an unbound kind forks nothing — was
  written first and reverted, because it made every existing
  `unit: { anonymous }` application silently lose its request scope on
  precisely its AUTHENTICATED procedures at upgrade, with no diagnostic
  anywhere; `examples/order-api` is the worked case, and its
  `"runs each call in its own unit"` spec is what caught it. A silent
  regression loses to a name reading slightly oddly.

  The fork is SEEDED with `[[auth.principals[scheme], identity]]` whenever a
  scheme resolved — **regardless of which module ends up forked**, so the
  anonymous fallback carries the seed too and an unread entry is the whole
  cost. That is what discharges a unit module's
  `needs: [auth.principals.user]`. A request no leaf authenticated is seeded
  with nothing, since there is no caller to name. `orpc.ts`'s
  `unitScope` middleware forks on **every leaf**, installed in `routerOf` after
  `principalMiddleware` where a leaf carries one — which is how the resolved
  scheme reaches it, on oRPC's own context as `resolved`. It runs only when oRPC's own
  dispatch reaches the leaf: an input oRPC's own schema refuses before any
  leaf middleware runs never forks either — proved by
  `examples/order-api/src/api.spec.ts`'s "never enters the handler for a
  malformed input", exactly as the runtime's own `404` does not.
  `htmx.ts` forks at the SAME point in the request's life — after
  authentication has succeeded and the body has validated, immediately before
  its handler runs, never for a request either answerer refuses — so both
  answerers fork exactly once dispatch has cleared every guard. A fork's own
  defect answers `500` through the path each answerer already had for any
  other defect: oRPC's own `INTERNAL_SERVER_ERROR` collapse for a throw out of
  `unitScope`, `refuse(response, 500)` for htmx — never `recoverDefect`, which
  sees only a bare answerer's own synchronous throw (above). **The runtime's own
  `404` never forks** — the
  behaviour change from the kernel forking a `StartOptions.unit` module around
  every unit, which is gone. Every bound kind's module's own unmet needs join
  `httpServer`'s own Needs channel, structurally, through a single
  `Units extends Readonly<Record<string, AnyUnitModule>> | undefined` type
  parameter — **less the principal the fork seeds**, which `UnitsNeedsOf<Units>`
  subtracts with `Exclude<…, PrincipalInstance>`, a `PortInstance` over the
  template-literal id every principal port carries. Measured: removing that
  `Exclude` makes `start` report
  `UNSATISFIED DEPENDENCIES — nothing provides: "HttpPrincipal:user"`, which is
  the whole point of the seed. (`AnyUnitModule = Module<never, never, unknown>`
  — `Module`'s `_exports` channel is contravariant, so the bound had to be
  `never`, not `unknown`, for a concrete module to infer against it at all;
  `@btravstack/testing`'s `TestRuntimeOptions.unit` carries the same bound for
  the same reason.) An import's own unmet needs are not `HttpModule`'s OWN call
  to re-declare (di's `NeedsGate` TSDoc), so they surface where any unmet need
  does — at `start`'s own `UNSATISFIED DEPENDENCIES`, never a marker of the
  kernel's: the module is forked over the application context, so its needs are
  exactly what the composition root must supply.
  `http-module.test-d.ts` pins all three directions — a kind whose module owes
  a port and gets it, one that does not, and one owing nothing but its scheme's
  principal, which starts with no provider at all.

- **`HttpModule` gates the kinds a root binds, because the fallback makes a
  typo silent.** An unbound scheme forks `anonymous` (above), so
  `unit: { usre: M }` would fork `anonymous` on every request and diagnose
  nothing — the one place the fallback's kindness turns into a trap.
  `UnitGate<Units, Router, Fragments>` rides an intersection on the option
  (`unit?: Units & UnitGate<…>`, the same shape as `routerFor`'s
  `contract: C & ScopeGate<C, Vocab>`) so `Units` still infers from the value
  and `UnitsNeedsOf<Units>` still reads it. Two cases:

  - **An answerer carries kinds** — an `api` from `units<…>()`, read back off
    the `_units` phantom by `UnitsOfAnswerer<T>`. **The router and the
    fragments both carry it**, so `DeclaredUnits<Router, Fragments>` takes
    whichever of the two has keys — a root supplying both got them from ONE
    `api`, so the two are the same type and the preference decides nothing.
    That is what puts a **fragments-only** root in this case rather than the
    weaker one below. The bindable set is
    `keyof DeclaredUnits<Router, Fragments>`, and each bound value must be
    assignable to the module type that kind declared. That half is **ordinary
    assignability**, not a marker: the diagnostic bottoms out at
    `Type 'Module<UnitSpan, …>' is not assignable to type 'Module<UnitTenant, …>'`,
    naming the kind and both modules, which no marker improves on. `Module`'s
    `_exports` channel being contravariant means a module exporting a
    SUPERSET is accepted, which is sound.
  - **Neither answerer carries any** — a plain `defineHttp()` api, which is what
    `examples/order-api` composes. The bindable set is `anonymous` plus every
    scheme the answerers serve, recovered by `SchemesOfAnswerer<T>` off the
    provider's own needs channel (`_needs: () => N`, then matching
    `PortInstance<"HttpAuthenticator:${infer S}", unknown>`): a router already
    owes one authenticator port per scheme its contract marks and a fragments
    provider one per scheme its routes require, so **no second phantom is
    needed** — the names are already carried where the graph needs them
    anyway. Both answerers are read, so a plain-api fragments-only root is
    gated by its own routes' schemes.

  An undeclared kind is refused against an `"UNDECLARED UNIT KIND — …"` marker
  rather than by excess-property checking, which cannot see one: `Units` is
  inferred FROM the value, so the typo'd key is part of the very type the
  check compares against. The marker's text carries no backticks, so it reads
  the way its siblings here do — `"UNIT DOES NOT PROVIDE — …"`,
  `"SERVES NOTHING — …"` — in a diagnostic that is already quoting a type.

  **The two cases treat a record whose keys are NOT literal — one built by
  `Object.fromEntries`, as the runtime fixtures do — differently, because they
  check against different things.** `UndeclaredKind` bails to `never` on
  `string extends keyof Units`, so neither case reaches the marker; what is
  left is the positive arm, and that is where they part. Case 1 keeps
  requiring every kind `units<…>()` declared, and a `Record<string, …>`
  supplies no NAMED property, so it is refused with TypeScript's own
  `Property 'anonymous' is missing` — the `units<…>()` half gates against the
  authenticator REGISTRY and holds either way. Case 2's set comes from the
  answerers' contracts instead, and with no `_units` to intersect against, the
  arm is the empty object: a non-literal record passes ungated. That is the
  weaker of the two and where a fixture lands.

  A **fragments-only** root under a `units<…>()` api lands in case 1 like any
  other: `htmxFragmentsFor` carries the phantom the router does, so its kinds
  are checked against the modules the declaration named rather than against
  `anonymous` plus the routes' own schemes. Case 2 is reached by a plain
  `defineHttp()` api and by nothing else.

  **`http()` and `httpServer()` stay un-gated**, and that is structural: they
  take the router as a NEED (`OrpcRouterPort`), never as a value, so their
  `unit` has nothing to check against. Their option keeps the wide
  `Readonly<Record<string, AnyUnitModule>>`. A hand-rolled composition that
  wants the gate composes through `HttpModule`.

- **Drain**: `stopAccepting` retires every open response — an unsent header
  gets `Connection: close`, a sent `text/event-stream` response is
  **destroyed** on the spot, any other sent one ends its socket on
  `'finish'` — and `stop()` destroys what is still open.
  `closeIdleConnections()` alone would miss a response with a request in
  flight; that is why retirement is tracked per-response rather than left
  to it. A stream is reset rather than ended cleanly because oRPC's client
  reads a clean end as the iterator finishing and never reconnects, while
  both it and a bare `EventSource` reconnect on a reset; the unit closes on
  the response and counts `completed`. The check reads **queued** headers
  (`getHeader`), so a future streaming answerer must set its `content-type`
  through `setHeader` rather than `writeHead` alone, or it is invisible to
  `isEventStream` and gets ended instead of reset. The position and its
  survey are in the root `CLAUDE.md`, thesis #5.
- **GET, for streams only**: the RPC handler's `allowMethods` admits `GET`
  when the matched procedure declares an event-iterator output
  (`getAsyncIteratorObjectSchemaDetails` on its `outputSchemas`) and keeps
  oRPC's default set otherwise. A browser's `EventSource` can only GET;
  nothing else a browser has reason to GET exists on an RPC surface.
- **Not included, deliberately**: another ROUTER for oRPC's own answerer (there
  is no `handler` option on `http()`; a second protocol is a second answerer,
  not a swap of this one), a middleware
  slot for application logic, `Result` → HTTP status, HTTPS, HTTP/2 — see the
  package README's _"What it does not do"_ for why each is a non-goal.
- **`httpServer(options)`** — the socket half: the runtime, its config, the
  kind → module record on `HttpUnit`, and no answerer. Its signature and what
  it provides and exports are in the reference page and `http-runtime.ts`.
  `http()` wraps this module and re-declares its own `exports`, so what the
  two export must be kept in step by hand. `httpServer` EXPORTS `Observers` as well as providing the
  no-op member: a sibling answerer that reports its own operations —
  `oidc()` is the first — answers providers rather than a module, with nowhere
  to put a no-op member of its own, so without the export the set port every
  other starter here gets for free would have been the one thing a login
  answerer charged a root for. The
  package's own transport specs, and a fragments-only graph, compose
  `httpServer` directly, with no oRPC router anywhere: a set port makes a
  single answerer welded to the socket the wrong default, and a fragments-only
  application would otherwise have to compose `http()` and declare an oRPC
  router it does not have. `httpRuntime`, the runtime value's factory, stays
  internal.
- **`htmx(options)`** (`htmx.ts`) — the second answerer: fragments. Its
  signature, options, injects and what it matches, forks and writes are in the
  reference page.

  **`login` is where this answerer and the login answerer touch, and it is the
  ONLY place the two know about each other.** It is the login ROUTE, not the
  prefix the login answerer is mounted under — `/auth/login` for an
  `oidc({ prefix: "/auth" })`, since `/auth` itself serves nothing and a
  redirect there is a `404`. Set it and a route whose `requires` resolves
  `Unauthenticated` sends the caller there carrying
  `?return=<encodeURIComponent(request.url)>` instead of answering a bare
  `401`: `303 Location` for a navigating browser, and `401` with `HX-Redirect`
  for a request carrying `HX-Request: true`. **The htmx half is not a
  cosmetic difference**: htmx follows a redirect inside the XHR and swaps the
  login page into whatever target the fragment named, so the browser has to
  be told to navigate the window rather than shown a redirect — and the
  status stays `401`, since the request was refused and only the navigation
  is a redirect. `HX-Request` is the discriminator because htmx sets it on
  every request it makes; nothing here reads `Sec-Fetch-Mode`, and no
  dependency was added for either.

  **`303`, not `302`, and it is reachable rather than pedantic.** `requires`
  is an option on `HtmxPost` too, and the CSRF gate refuses only a
  cross-site request — so a same-origin no-JS `<form method="post">` behind
  `requires`, from a logged-out browser, reaches this branch today. RFC 9110
  §15.4.3 leaves a `302`'s POST-to-GET change a **MAY**, so a strict client
  would re-POST the form body at the login route; §15.4.4's `303` specifies
  the retrieval request instead.

  **`UnderScoped` stays `403` whether or not `login` is set.** A caller who IS
  logged in and lacks the scope would come straight back to the same `403`;
  sending them to log in again teaches a loop. That split is why the
  `mapErrCases` fold answers a small `Refusal` — `{ status }` or
  `{ login }` — rather than the bare number it used to: the redirect decision
  is one branch beside the status one, and the fold stays exhaustive on
  `resolveScheme`'s `Err` union, so a third case added there still fails this
  compile.

  **The `return` value is GUARDED where it is minted, and that guard is not
  belt-and-braces.** It is the request's own path and query, `request.url` as
  it arrived, percent-encoded ONCE — but only when it starts with `/` and its
  second character is neither `/` nor `\`; anything else is reported as `/`.
  Those two clauses are the whole of `src/redirect.ts`'s `returnTo`, which
  `oidc()` calls as well — sealing the value at `/login` and following it at
  the callback, where it is decoded exactly once. They are what the guard is
  FOR: whether a HEADER can carry the result is a separate question, answered
  by `forLocation` at the `Location` rather than by a third clause here.
  A protocol-relative target is manufacturable through a route that looks
  nothing like one: a route whose FIRST segment is a parameter
  (`api.HtmxGet("/:slug", { requires })`) matches the crafted target
  `/\evil.com` — one non-empty segment, so `matchPath` is satisfied and the
  runtime's mount gate is too — and `new URL("/\\evil.com", base)` resolves
  to `https://evil.com/`, the WHATWG parser reading `\` as `/` in
  relative-slash state. Minting it and trusting the login answerer to reject
  it would put the check one package away from the fact that produced it, and
  a login answerer is not the only thing that will ever read a `return`. What
  stays the consumer's is the rest of the open-redirect question, at the point
  the value is about to be followed.

  **Routes are matched in the composition root's own array order, first match
  wins — and that ordering is a SECURITY property, not only a routing one.**
  Two contract keys are two port ids, so di has nothing to see collide; an
  UNMARKED route declared before a MARKED route whose path can also match the
  same request answers it, and no authentication ever runs. There is
  deliberately no specificity rule — the ordering is the composition root's
  own, on purpose — and `htmx()`'s own TSDoc states this.

  **The POST body decodes through `Object.fromEntries(new
URLSearchParams(...))`, which keeps only the LAST value for a repeated key.**
  A `<select multiple>` or a checkbox group — both mainstream htmx shapes —
  collapse to their last selection rather than an array. This is a stated
  limitation, not a bug: a route wanting every value has no seam here but its
  own decoding ahead of `input`.

  The body is read while enforcing the limit as bytes arrive, never buffered
  whole first, and an over-limit request keeps draining rather than being
  destroyed: destroying an `IncomingMessage` destroys the socket the `413`
  would ride out on.

  **The decoding assumes `application/x-www-form-urlencoded` and never checks
  `content-type`.** A JSON body still passes through
  `new URLSearchParams(body)`, which reads the whole payload as one garbage
  key with an empty value — form-urlencoded only, the same stated limitation
  as the repeated-key one above rather than a validated content type.

  **Every `200` carries `Cache-Control: no-store`, unconditional — not keyed
  on `route.requirements`.** A public route can still render a caller- or
  resource-scoped fragment off a path parameter alone, and this package has
  no way to know a route's output is safe for a shared cache to keep, so
  there is no cheaper signal than "never store" to key the header on.

  **A route always answers `200` on success, and cannot set a header or a
  status of its own.** `respond`'s success path is unconditional: `HX-Redirect`,
  `HX-Trigger`, `HX-Retarget` and `HX-Reswap` — htmx's own response mechanics —
  are unreachable, and a route cannot answer its own `404` or `422`; "not
  found" is rendered markup (`orderRowFragment`'s own triage in the how-to),
  never a status. A defensible scope decision, not an oversight.

  **A refusal (`401`/`403`/`413`/`422`) carries no body**, where the runtime's
  own `404`/`500` fallback carries `application/json` — `refuse` owes the
  caller nothing beyond the status.

### Unit kinds: `auth.principals` and `auth.units<…>()`

A unit is opened under a KIND — `anonymous`, or the scheme that resolved a
credential — and a kind binds a `Module` whose providers may inject the caller
the unit was opened for. Two members on `Http<A>` carry that:

```ts
export const auth = defineHttp({ authenticators: { user: userAuth } });
// `auth.principals.user` is a port carrying `userAuth`'s own principal type.

export const api = auth.units<{ anonymous: typeof Anonymous; user: typeof User }>();
```

- **`principals`** is one port per declared scheme, minted by `principalPort`
  on the same memoising map as `authenticatorPort` and typed by the principal
  that scheme's authenticator declared. It is a PORT, not a value: a unit
  module names it in `needs` and injects it, and the seed lands on it per unit.
- **`units<U>()` is a SECOND step, and that is the whole design.** A unit
  module names `auth.principals.<scheme>` in its own `needs`, so its type
  depends on `typeof auth`; if `auth` in turn depended on the modules the kinds
  bind, the two would be mutually recursive and TypeScript reports TS7022 —
  `auth` implicitly `any` because it references itself. Splitting the call in
  two breaks the loop: **`typeof auth` depends on the authenticators ALONE**,
  and the modules arrive on a call that only retypes what already exists.
  Nothing is rebuilt — `units` hands back the very same object
  (`define-http.spec.ts` pins the identity), so the factories on it are the
  ones the first step built. Do not fold `Units` into `defineHttp`'s own type
  parameters.
- **`UnitsOf<A>` alone does NOT refuse an undeclared kind — the exactness arm
  on `units` does.** `UnitsOf<A>` is
  `Partial<Record<Kinds<A>, AnyUnitModule>>`, and a type argument gets no
  excess-property check, so `{ anonymous, service }` is structurally assignable
  to it and `service` would be silently ignored — a kind whose module is never
  forked and whose seed never lands, with no diagnostic. What closes it is the
  second half of `units`' constraint,
  `{ readonly [K in Exclude<keyof U, Kinds<A>>]: never }`: every key outside
  `Kinds<A>` is required to be `never`, which no real module is, and the error
  names that key. (A record of _only_ undeclared kinds is refused a second way,
  by weak-type detection — every member of `UnitsOf` is optional, so it shares
  no property at all — but that rule fires on zero overlap and is why the
  mixed record needed the exactness arm.) `Kinds<A>` is
  `"anonymous" | (keyof A & string)`, so `defineHttp()` with no authenticators
  has exactly one kind. `define-http.test-d.ts` pins both refusals and the
  positive between them; removing the exactness arm leaves the mixed record's
  `@ts-expect-error` unused, which is a `TS2578` (measured).
- **`Units` is a phantom on `Http<A, Units>`** (`_units?: Units`), read by the
  piece factories' leaf typing and never at runtime. Without the field
  TypeScript erases the parameter and `Http<A, U>` collapses back to `Http<A>`.

`unit.ts` is where `AnyUnitModule`, `UnitExportsOf`, `UnitNeedsOf`,
`UnitsNeedsOf`, `PrincipalInstance`, `Kinds`, `UnitsOf`, `KindOf`, `InAll`,
`UnitFor` and `unitRecordOf` live; `http-runtime.ts` re-exports
the two `http-module.ts` imports through it — knip refuses a re-export nothing
consumes, so the rest stay reached at their own path.

### `context.unit` and `UnitFor`

A piece — or a fragment route — declares the unit-scoped ports its leaves may
read **once**, as a record beside `inject`, and every leaf reads them off
`context.unit`:

```ts
api.OrpcController(contract, "orders")({
  inject: {},
  unit: { span: Span, tenant: Tenant },
  sync: () => ({
    find: ({ context }) => OkAsync(context.unit.tenant),
  }),
});
```

- **The gate is a mapped type's key filter, not a checker this package
  writes.** `UnitFor<U, Units, K>` re-keys the declared record with
  `as InAll<…> extends true ? N : never`, so a name the leaf's kind cannot
  provide is not a property at all — reading it is TypeScript's own
  `Property 'tenant' does not exist`, at the line that reads it rather than at
  the mint. `KindOf<…>` is what selects the kind: `anonymous`
  for a leaf nothing marks, else the schemes its requirements name — read off
  `Effective<C, R>` for an oRPC leaf, and straight off `requires` for a
  fragment route, which has no contract to fold. A leaf
  accepting several schemes keeps only what **every** one of their modules
  exports — `InAll` is a conjunction over the distributed union — because the
  runtime forks exactly one of them and cannot know which in advance.
- **The fallback is restated on the type side, and has to be.** A scheme that
  binds no module falls back to `anonymous` at runtime, so `ModuleOf<Units, K>`
  answers `anonymous`'s module for an unbound kind. Without it a two-scheme
  leaf with only `user` bound would see `user`'s exports and then read a port
  off an `anonymous` fork that never provided it. With `units<…>()` never
  called, `Units` is the empty record, every name filters out and
  `context.unit` is `{}` on every leaf — which is what keeps a piece that
  declares no record compiling exactly as before.
- **The record's entries are LAZY getters, built by one function both
  answerers call.** `unitRecordOf(forked, record)` installs one
  `Object.defineProperty(unit, name, { enumerable: true, get })` per declared
  name over the forked `Context` — neither writable nor configurable, so a
  handler reads what the fork holds and cannot reshape the record under the
  next one. Eager resolution would call `forked.get` for
  every declared port on every request, the ones `UnitFor` hid included — a
  defect for a port the forked kind never provided, raised on a name no leaf
  of that kind could have read. Lazy, an unreadable name costs nothing.
  **Past the types, the getter is what fails**: `forked.get` throws di's own
  `[di] no service registered for port …`, naming the port, and that is a fork
  defect answering `500` like any other. Reaching it takes a cast, and the two
  routes in are closed differently — `HttpModule` checks a bound module's TYPE
  per kind, so a kind whose module does not export what a leaf reads is refused
  there; and under a plain `defineHttp()` api, where the bindable set carries no
  kinds, `UnitFor` filters out **every** declared name (`ModuleOf` resolves to
  `never`, so `InAll` is `false` for each), which makes the read a compile
  error rather than a runtime one. It
  lives in `unit.ts` rather than in either answerer because `unit-scope.ts`
  and `htmx.ts` fork at their own sites and must agree on the record's shape:
  two copies of a lazy getter is exactly the drift `seedOf` was extracted to
  prevent one seam earlier.
- **The record is per PIECE, and a leaf takes its nearest one.** The
  `{ inject, sync }` arm registers one record under `""` and every leaf gets
  it; the array arm builds a `Map<piecePath, record>` off each minted piece's
  own `unit` field, and `routerOf` walks the dotted path it is already
  building to find the nearest ancestor entry. That is why `Minted` carries
  `unit` at runtime, the way `MintedRoute` carries `route`. A fragment route
  has no tree and needs no lookup: `MintedRoute` carries its own `unit`
  beside `route`, `HtmxFragments` copies it onto that route's
  `FragmentAnswer`, and `htmx.ts` builds the record right after its own fork.
  A route that binds no kind at all is handed `{}` rather than nothing —
  `UnitFor` has hidden every name in that case, so there is nothing to read.
- **The port's own service type stays unit-free.** `ControllerPortOf` is
  `Implementation<FragmentAt<C, K>, Schemes>` with the record defaulted empty,
  so two pieces declaring different records still compose under one contract
  and the lifted-fragment property (`controller.test-d.ts`'s fifth gate)
  survives. Only the mint's `sync` parameter is typed by the record. The cost
  is that a **lifted** single-slice root
  (`api.OrpcRouter(contract.orders)({ inject: { implementation: piece.port }, sync: ({ implementation }) => implementation })`)
  injects the PORT, whose service type erased `U`, so the router registers no
  record and a piece that declared `unit:` receives `{}` at runtime once
  lifted. A lifted root must restate `unit:` on the router arm.

## The session codec — from `@btravstack/http-server/session`

**`sessionCodec({ keys?, ttlSec? })`** — a `Provider(SessionCodec)` binding the
storage-free half of the session: `seal` turns a principal into a JWE, `unseal`
turns a cookie back into a `Session<unknown>` or into nothing. `jose` is the
optional peer for BOTH `/jwt` and `/session` — one peer, two subpaths, declared
`optional: true` once — and the subpath is what keeps a consumer that never
verifies a token or logs a browser in from installing it.

**The cookie is the session, so the key list is the one operational object.**
`HTTP_SESSION_KEYS` is a `Config.list` of base64url 32-byte keys. The FIRST
seals and EVERY one unseals, which is what makes rotation prepend, deploy, drop:
a cookie sealed with a key the deploy dropped is **anonymous**, never an error,
because a browser holding a stale cookie is a browser that logs in again and not
a failed request.

**`dir` + `A256GCM`, and `iat`/`exp` in the PAYLOAD rather than in the JWE
header.** A JWE header is authenticated but not encrypted, so a lifetime there
is readable by anyone holding the cookie; and the expiry is then checked on the
plaintext, by the same code that decrypted it — after the AEAD tag has already
said the bytes are ours.

**`seal` stamps the lifetime; it does not accept one.** Its argument is
`Omit<Session<unknown>, "iat" | "exp">`, so whatever mints a session cannot mint
one that outlives the policy — a caller passing `exp` is a compile error, which
`session.test-d.ts` pins. `ttlSec` is an OPTION and not a variable, on rule 6's
own test: it is the posture `securityHeaders` is, and its silent change is a
regression rather than a deployment detail.

**The service publishes `ttlSec`**, for `oidc()` one subpath over: a login
writes the cookie, so it needs the number `seal` stamps to put in `Max-Age`.
The two are one fact and only the codec holds it, so a wrapper that guessed
would either drop the cookie while the session was live or keep sending one
that unseals to nothing. It is read-only, and it is the whole of what the codec
publishes for the login — the cookie helpers live in `cookie.ts`, which is not
an entry point.

**`unseal` decrypts only what `seal` issues — the ALGORITHM half.**
`compactDecrypt` is handed `keyManagementAlgorithms: ["dir"]` and
`contentEncryptionAlgorithms: ["A256GCM"]`, derived from the same `HEADER`
constant the seal writes so the two directions cannot drift. Without the pin, a
token this key sealed under `A256KW`, `A256GCMKW` or `dir` + `A128CBC-HS256`
OPENS. None of that is forgeable without the key, which is what the pin is
about: it refuses **another algorithm under our key**, so a sibling holder of
`HTTP_SESSION_KEYS` cannot reach this codec with a JWE shaped its own way.

**`typ: "session"` is the PURPOSE half, and it is the one that matters for what
ships next.** The algorithm pin buys nothing against something sealed the way we
seal: `oidc()`'s five-minute transient `__Host-oidc` cookie will be `dir` +
`A256GCM` under these very keys, which is precisely what the allow-list admits —
and a cookie NAME is not a boundary, since `__Host-` is enforced by the browser
on `Set-Cookie` and never on a request, so a client is free to replay its own
transient as `Cookie: __Host-session=…`. So `seal` writes `typ` into the
plaintext and `sessionOf` requires it back: what the payload IS, checked before
what shape it has. The alternative on the table was leaving the presence of
`principal` to separate them, which held only by an accident of field naming
nothing stated — and the cost of adding a REQUIRED field to a cookie format
already in the wild is a global logout at deploy, the same failure `decodeKey`'s
round trip worries about. Two lines now beats a deprecation window on a cookie.

**`codec.transient` is the login flow's own cookie, on the SAME codec.** `seal`
takes a `Record<string, string>` — a PKCE verifier, `state`, `nonce`, where to
return to — and writes `typ: "oidc"`, `iat` and `exp` over it; `unseal` requires
that marker back and answers the state with the markers stripped. The two
markers therefore refuse each other in BOTH directions, which is what makes a
replayed transient anonymous under the session's name and a replayed session
nothing under the login's.

**It is a pair on the codec rather than a second provider, because the KEYS
live inside the codec.** `make` decodes `HTTP_SESSION_KEYS` once and closes over
the decoded bytes; nothing hands them out. So a second provider is either a
second `sessionCodec()` — di's duplicate-provider defect, refused at build — or
a second port re-reading the variable, with its own decode, its own
`ConfigInvalid` message and its own rotation story for one list an operator
rotates once. One codec, two purposes, one key list is the shape the `typ`
marker was already paying for.

**`TRANSIENT_TTL_SEC` is 300 and is NOT an option.** `ttlSec` is a posture a
deployment argues about; five minutes between the redirect out and the callback
back is not — a login that takes longer is a login to start again, and a knob
there would only ever be turned up. With no `ttlSec: 0` route into it, the
expiry spec forges a payload with a past `exp` under the codec's own key, which
is the same fixture the purpose and shape cases already use.

**The state is strings, and the guard says so.** `transientOf` requires the
marker, a numeric `iat`/`exp`, and every OTHER property a string — flow state is
what goes in a query string, not a principal — so a forged nested object or
number is `undefined` like everything else. `seal` writes the markers LAST, so a
caller whose state spells `typ` cannot decide what the payload is.

**The plaintext is authenticated, not validated.** The AEAD tag says the bytes
are ours; it says nothing about what they are or what shape they have, and a key
this codec holds could have sealed anything. So `sessionOf` checks `typ`, then
`principal`, a numeric `iat` and a numeric `exp` before the payload is trusted —
a `null` one used to defect on `.exp` through a channel typed `never`, and a
string `exp` used to coerce its way past `exp > now` and open.

**Key SHAPE and length are checked here, not by `Config.list`.** The field knows
nothing about keys, so `make` decodes each one and folds a bad key into a
`ConfigInvalid` naming `HTTP_SESSION_KEYS` — at boot, with `runMain`'s `78`,
rather than as the first request's unexplained failure. It is the `Config.url`
argument one variable over: the check belongs where the value is finally handed
to the library. The check is a **round trip**, not a length: `Buffer.from` drops
what base64url cannot spell, so a stray character decodes to 32 bytes anyway —
and if it shifts the alignment, 32 DIFFERENT bytes. A typo would otherwise boot
green and log every session out, against a message promising base64url.

**A key list is PER DEPLOYMENT, and there is no `iss`/`aud` binding — declined,
not missing.** Two deployments handed the same `HTTP_SESSION_KEYS` accept each
other's sessions: a cookie minted by staging opens in production. An audience
field would refuse that, and it is not here because the thing it would protect
against is an operator copying a secret between environments, which the same
operator can undo by copying it back — the check would be advice, not a boundary,
and every real boundary it names (a different key) is one the key list already
draws. `typ` is a different case and IS here: it separates two purposes that
legitimately share one key list inside one deployment, which nothing else can
separate. Mint a list per deployment; the codec's rotation story is what makes
that cheap.

**Every failure to unseal is the same `undefined`.** No cookie, a string that is
not a JWE, a key that is gone, an edited ciphertext, another algorithm, another
purpose, a payload that is not a session, one past its `exp` — one answer, so nothing outside learns
which of them it got wrong. That is `Unauthenticated`'s rule (a refusal carries
no reason) applied one layer lower, and it is why `unseal` is
`AsyncResult<Session<unknown> | undefined, never>` rather than an error channel
with eight arms.

**The clock is `Date.now()`, not a `Clock` port.** There is none on this seam —
the codec is a provider, not a unit — so the expiry spec pins the boundary with
`ttlSec: 0` (`exp === iat`, and `>` refuses it) rather than by aging a cookie.
A `Clock` here would be machinery bought for one test.

## `oidc()` — the login answerer, from `@btravstack/http-server/oidc`

**It is an ANSWERER, not a scheme, and that is the design.** A login is a
redirect protocol — three requests, a cookie written on two of them, a browser
away at somebody else's site in between — where an `AuthenticatorService` is
handed headers and answers a principal. There is nowhere in that shape to put
a `Set-Cookie`, a `Location` or a callback route, so this is one more member of
the same set port `orpc()` and `htmx()` contribute to, mounted at `prefix`
(default `/auth`). It owns every path under its mount and answers its own `404`
for one it serves no route for, rather than resolving unwritten the way
`htmx()` does — `htmx()` is mounted at `/` by default and shares that space
with everything, where this owns a prefix nobody else claims.

**An `http:` issuer is REFUSED at boot unless it is loopback or opted in.**
`Config.url` validates that a value parses; nothing validated what it meant.
An `http:` issuer sends the client secret, the code and every token in the
open — and `discover` then applies `allowInsecureRequests`, which is precisely
the check that would otherwise have refused, so the downgrade was silent in
both directions. `localhost`, `127.0.0.1` and `[::1]` are taken as they stand
(the dev loop's own Ory is `http://localhost:4444/`, which is why the whole
suite exercises that arm); anything else is a `ConfigInvalid` naming the
variable unless `allowInsecureIssuer: true` is pinned. It is an **option**, not
a variable, on rule 6's test — `securityHeaders`' own argument — and the flag
`discover` takes is COMPUTED once by `cleartext` and handed in rather than
re-derived there, so the check that refuses and the switch that permits cannot
drift apart.

**The rule lives in `cleartext.ts` because two callers need it and they
disagreed.** `oidc()` refused a cleartext issuer from the day it shipped;
`jwtAuthenticator` handed an `http:` JWKS URI straight to `jose` — the same
class of value, two answers, and the silent one was the sharper hole: a key
set carries public keys, so substituting a signing key and minting accepted
tokens needs no secret stolen first (RFC 8725 §3). One predicate and one
message builder now serve both, with the loopback exception and the
option-not-a-variable posture written once. The alternative on the table was a
`protocols?: readonly string[]` option on `Config.url`; it was declined
because the loopback exception is not expressible as a scheme list, and a
second option to carry it would put a security rule in a package that knows
nothing about what a URL is for.

**Discovery runs ONCE, in `make`.** Three consequences, and each is why it is
there rather than per request: a provider that is not there fails the BOOT with
`OidcUnreachable` naming the issuer — a modeled startup error beside
`ConfigInvalid`, which `runMain` turns into an exit code — instead of a `500`
on the first login; the JWKS cache and the server metadata are one per process;
and `allowInsecureRequests` is applied in the right two places once rather than
in a hot path. It is applied TWICE for an `http:` issuer, as a `discovery`
option and again to the configuration that call answers, because the option
does not carry over (measured against a real Hydra); and
`enableNonRepudiationChecks` is what makes the ID token's SIGNATURE checked at
all — OIDC Core lets a client trust a token that arrived over TLS from the
token endpoint, which is a trust this package does not extend.

**A refusal is `400` unless the PROVIDER refused, which is `401`.** No
transient cookie, one no key opens, one past its five minutes, a `state` that
does not match and a `principal(claims)` answering `undefined` are all `400`:
this end could not make sense of the callback. A code the provider would not
exchange is `401`. None of them seals a session; every one of them CLEARS the
transient, which is the point of routing them all through one `refuse`.

**Each route is an OPERATION on `Observers`, and it holds no `Logger` of its
own.** That is the root spec's rule — a starter reports what it did and holds
no `Logger`, `Meter` or `Tracer` — and the one exception it names,
`@btravstack/prisma`'s, is explicitly a STARTUP fact rather than an operation,
so it does not cover this. A refused login is the one refusal in this package
that DESTROYS information: the provider's reason must not cross the wire, a
`401` is not an error the runtime's RED metrics count, and `grant_failed` looks
identical whether the client secret rotated, the token endpoint died, or the
code was genuinely bad. So each refusal settles `outcome: "error"` with
`attributes: { reason }` — five literal values, safe on an instrument — and the
unbounded half, the provider's `error_description` and the library error's
message, rides the `cause`, which an observer puts on a line or a span and
never on a metric. That split is why this could not be a `Logger`: a `warn`
line's attributes are one channel, and the port draws the line the thesis
draws.

**Each observation is ended by the RESPONSE, not only by the code path that
wrote it.** `observe`'s finisher is once-only, so a refusal's own `settle` wins
and the `'close'` listener is a no-op — it is there for the paths that reach no
`settle` at all. A codec defect rethrown by `.get()`, or a rejected PKCE
digest, would otherwise leave the span open and the request out of the counters
entirely, which is worse than the defect it came from; `'close'` always fires,
and by then the runtime's own `500` is on the wire, which is what the outcome
reads. It is `http-runtime.ts`'s own rule for the request, applied one level
down — `response.closed` checked first, because subscribing to a stream that
already fired is this package's documented footgun.

## `openApiDocument` — from `@btravstack/http-server/openapi`

The surface and its reasoning are in `docs/reference/http-server.md` and
`openapi.ts`'s TSDoc.

**The requirements walk keys on `@orpc/openapi`'s own `getOpenAPIMeta`, not on
the contract path**, because the generator writes
`meta?.operationId ?? path.join(".")` and the two stop agreeing the moment a
procedure names an `operationId`. Keying on the path alone dropped every such
operation's `security` and published it as public, while the TSDoc claimed the
opposite. Importing the accessor rather than reproducing the rule is what makes
the two agree by construction: if upstream changes how an id is derived, this
changes with it.

`StandardJsonSchemaConverter` is what converts the schemas, and it is why no
`@orpc/zod` is needed: zod v4 is Standard Schema, and `@orpc/zod` publishes no
`2.0.0-beta.28` to match the catalog's pin anyway.

## Several answerers, one runtime

**Routing is by longest matching prefix, and there is no chain.** `/rpc` owns
`/rpc` and everything under it; a `/` fragment answerer takes the rest. The
path is read with `URL.parse(request.url, "http://x")`, not by splitting on
`?`: the request target is origin-form from a browser and **absolute-form**
(`GET http://host/rpc/x`) from some forward proxies, and the split left the
second matching no mount at all. `URL.parse` rather than `new URL` because a
target no parser accepts must not throw out of the request callback, where the
kernel's `uncaughtException` handler would read it as the application failing. Nesting
is the expected shape rather than a conflict, so ordering never has to be
decided — which is the whole reason this beat #174's own option (2), where a
chain of "answer or decline" would have made ordering a property of provider
registration across modules and visible in no single line. A path no mount
point covers is the runtime's own `404`, written before any answerer is
consulted; a path a mount DOES cover, whose answerer declines, is the same
`404` it always was.

**An answerer outside a contract carries its own authentication, and nothing
checks that it did.** `@btravstack/contract`'s marker is what says which scheme
protects an oRPC procedure, and `defineHttp({ authenticators })` is what
resolves it. A fragment or GraphQL answerer has no such statement of intent, so
its routes are **public** unless it brings authentication of its own — the same
way an unmarked procedure is public, and with the same absence of a gate for
"you forgot". Do not describe a non-oRPC answerer as protected by the
contract's marker. What it brings is declared as data on the route — `requires`
on `api.HtmxGet`/`api.HtmxPost`, checked at the mint by `RequiresGate` and
resolved through the same walk oRPC's leaves use — and a GraphQL answerer
inherits that seam the same way.

## Cross-cutting concerns: configuration, not a middleware slot

An oRPC plugin and the starter's own `principalMiddleware` act on the **request/response envelope** — bytes,
headers, a principal resolved before dispatch. An application middleware would
act on the handler's **`Result`**, and that is the only one `@btravstack/http-server`
refuses, because it is the one that would put a use case's outcome in the
transport's hands.

- **Rate limiting is a stated non-goal.** A per-process counter is the wrong
  unit: an `api` deployment is N pods (thesis #1), so a per-process budget is
  N independent budgets and none of them is the limit anybody meant. The
  ingress or gateway is where a request count is counted once. An application
  that wants one anyway writes a plugin and passes it through `plugins` —
  which is the escape hatch doing its job, not a gap.
- **An unmarked procedure is public, and nothing fails if the marker is
  forgotten.** `@btravstack/contract`'s marker makes the requirement
  **legible** in the contract and makes the principal's type reach the
  handler; it does not detect a procedure that should have been marked. There
  is no gate for "you forgot", and there cannot be one — the contract is the
  only statement of intent there is. Do not describe an unmarked procedure as
  checked.
- **Authorization is deliberately not in the contract.** "May this caller do
  this?" often depends on the resource — the order's owner, its state, the
  row's tenant — which cannot be answered before the handler has run and
  fetched it. Putting the caller-shaped half in the contract and leaving the
  resource-shaped half in the handler splits one rule across two files, and
  the half in the contract is the half that looks complete. Authentication —
  "is there a principal, and what is it?" — is answerable before dispatch, and
  is the only half the contract carries.

## RED metrics: the runtime records them, because only it can

**Recorded on the response's `'close'`, not on the unit settling.** The metrics'
names and dimensions are in `docs/reference/http-server.md`. The two would
usually agree — the unit's own contract is that the response is flushed inside
it — but `'close'` is the one event that has seen the FINAL status, which
includes the runtime's own `404` (no answerer claimed the path) and the `500`
the `recoverDefect` arm writes. Neither of those reaches an answerer, so
neither could be recorded by one, and that is the whole argument for the
metrics living here rather than in a plugin or in the application: an
application cannot see the requests its handlers never ran.

**The dimensions are chosen for CARDINALITY, and the absent one is the
decision.** The request PATH is not a dimension — `/orders/42` mints a time
series per order, which is the classic way a metrics bill becomes the incident.
`answerer` is a mount prefix, so the graph bounds it; `status` is a small
integer set; `method` is HTTP's own closed list. An application that wants
per-route timing has the contract's own procedure name and its own `Meter`.

**`status` is what was MEANT, so the outcome is decided by the flush.**
`ServerResponse.statusCode` defaults to `200` and nothing rewrites it when a
socket dies, so a client that walked away mid-body and a `text/event-stream`
the drain reset both settled `ok 200` — the request an operator most needs to
see never appearing in the errors half of RED. `aborted` is
`!response.writableFinished` read at `'close'`, it is a fourth dimension
(boolean, so the cardinality argument above is untouched), and an aborted
request settles `error` whatever its status says. A deploy's own stream resets
are therefore errors too, which is truthful — the `aborted` dimension is what
separates them from a genuine `500`.
