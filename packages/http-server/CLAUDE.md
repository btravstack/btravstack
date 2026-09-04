# packages/http-server

The HTTP starter's public surface. The root `CLAUDE.md` is the authoritative
spec for the kernel and the conventions; this file holds what only matters when
you are working under `packages/http-server/`. Keep it in sync with the code in
the same commit, and with `README.md` — the package ships no
`docs-examples.test-d.ts`, so nothing else compiles these claims.

## Public surface

- **`HttpModule(name)({ router?, fragments?, fragmentsPrefix?, prefix?, port?, hostname?, cors?, bodyLimit?, compression?, plugins?, securityHeaders?, imports?, provides?, exports?, needs? })`**
  (`http-module.ts`) — THE way an application declares an HTTP deployment:
  `Module(name)({...})` plus a router, fragments, or both. It appends
  `httpServer(options)` to `imports`; when `router` is supplied it prepends
  the router **and** `orpc(options)` to `provides`, mounted under `prefix`
  (default `/rpc`); when `fragments` is supplied it prepends the fragments
  provider **and** `htmx({ prefix: fragmentsPrefix })` — `fragmentsPrefix`
  (default `/`, `htmx()`'s own default) is the second, independently-named
  mount point, since one field cannot carry two mounts with two different
  defaults. Either or both, plus each answerer's own scheme authenticators —
  read off `router.authenticators` and `fragments.authenticators`,
  deduplicated by **reference** before they reach `provides`, so a scheme the
  two share (one `defineHttp` call, named by both) lands once. `HttpRuntime`
  and `HttpHandler` are appended to `exports` — the runtime resolves
  `HttpHandler`, so `start`'s gate needs it exported regardless of which
  answerer(s) compose it — and the augmented tuples — `Imports<I>` /
  `Provides<P, Router, Fragments>`, readonly and exact — go to di's own
  `Module(name)({...})`, whose
  return type IS the sugar's: nothing spelled twice. di exports `AnyModule`,
  `AnyProvider` and `Exportable` for exactly that (constraining the tuples the
  way `Module(name)` does); its other module-typing pieces stay internal.
  (Spelling the return through a named generic alias was tried and removed:
  declaration emit keeps such an alias unreduced and cannot name imported
  modules' internal ports — TS2883, measured.) `router` is
  `Provider<OrpcRouterPort, RouterError, RouterNeeds>` — what
  `api.OrpcRouter(contract)({ inject, ...arm })` returns; `fragments` is
  `Provider<HtmxFragmentsPort, …>` — what `api.HtmxFragments([…])`
  returns. A provider of anything else fails at the call, and there is no
  port to read off either: the sugar's job is to provide the port the
  matching starter needs. Covered by the package's own `rpc` fixture (router
  alone) and `bothProtocols`/`sharedAuth`/`fragmentsOnly` (fragments alone and
  both together). Options `port`/`hostname` pin as for `http()`.
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
  alone identifies this arm — an array is never a valid `{ inject, ...arm }`
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
  `{ inject, ...arm }` form, which never nests. The pieces themselves still need
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
  Both sentences point at the `{ inject, ...arm }` form, which splits nothing and
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
  `{ inject: {}, sync }` like every other no-deps provider (issue #227).
  Returns
  `Provider<InstanceType<ControllerPortOf<C, K, Schemes>>, never, N> & { readonly port: ControllerPortOf<C, K, Schemes> }` —
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
  if the marker is forgotten.

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
  none is given. The minted provider carries `.port` and `.route` (`method`,
  `path`, `input`, `requires`) — what the array arm below reads back to
  compose without the path or the requirement being spelled twice.

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

- **`http({ prefix?, port?, hostname?, cors?, bodyLimit?, compression?, plugins?, securityHeaders? })` →
  `Module<HttpRuntime | HttpConfig | HttpHandler, ConfigInvalid, Env | OrpcRouterPort>`**
  — the starter, and **oRPC's answerer under the HTTP runtime**: one protocol,
  over its own node adapter, contributing one member to the `HttpHandler` set
  port. It used to be "the one way HTTP is answered here" and is not any more —
  see **Several answerers, one runtime** below. The
  former `@btravstack/orpc` was folded in for that reason — oRPC shares this
  stack's convictions (a contract, typed errors, `Result` at the boundary), so
  it is enforced, not offered among alternatives. The router is not an
  option: the module **needs** `OrpcRouterPort`, and the application provides
  it — a provider that declares the use cases its procedures call (di injects
  them, oRPC's context stays empty), built by
  `api.OrpcRouter(contract)({ inject, ...arm })`. The starter provides
  `Runtime<never, HttpInfo>` on the **`HttpRuntime`** port (a class over
  core's `RuntimePort`, **an empty `resolves`**), which the composition root imports
  next to the application and exports so `start` finds it, and **`HttpConfig`**
  (`{ port, hostname, bodyLimit, corsOrigin, compression }`) bound through
  `Config.provider` from `PORT` (default `3000`), `HOST` (default `0.0.0.0` — a
  pod, not a laptop), `HTTP_BODY_LIMIT`, `HTTP_CORS_ORIGIN` and `HTTP_COMPRESSION` in the
  kernel's `Env`. It is declared in `http-config.ts` rather than
  `http-runtime.ts` because `orpc.ts` reads it and `http-runtime.ts` imports
  `orpc` — a leaf module is what keeps that from being a runtime import cycle.
  Every field **pins** instead of reading — explicit >
  env > default, per field (`Config.pinned(value, field)` swaps the field's
  `parse` for a constant and keeps the variable name). A pinned field reads
  nothing from the environment; the declared `Env` need and `ConfigInvalid`
  stay whatever is pinned — one signature, no overload pair to keep in step
  (the kernel discharges the one, a pinned config never produces the other).
  There is **no fully-pinned shortcut provider** any more: it existed to skip
  the `Env` read when `port` and `hostname` were both given, and with five
  fields it would have been a branch nobody could satisfy — `Config.pinned`
  already reads nothing.
  `prefix` (default `/rpc`) is where the RPC endpoint is mounted. The worked
  example is `Module("OrderApi")({ imports: [Application, Persistence,
http()], provides: [orderRouter], exports:
[HttpRuntime] })` + `runMain(OrderApi)`; a test passes `env: { PORT: "0",
HOST: "127.0.0.1" }` to `start`. `HttpInfo` is `{ port }`, published on
  `Serving.info` once bound; `0` lets the OS pick, read back via
  `runtimeInfo()`.
- **`cors`, `bodyLimit`, `compression`** — three oRPC plugins as named
  options, each typed by the plugin's own options type per the passthrough
  rule: `boolean | CORSHandlerPluginOptions<DefaultInitialContext>`,
  `number | false`, and
  `boolean | ResponseCompressionHandlerPluginOptions<DefaultInitialContext>`.

  **Each SCALAR half is a field of `HttpConfig`, not a closure**, bound from
  `HTTP_BODY_LIMIT`, `HTTP_CORS_ORIGIN` and `HTTP_COMPRESSION` and **pinned** by the option —
  explicit beats environment beats default, per field, the same
  `Config.pinned` shape `PORT`/`HOST` already used. The option is what a test
  or a fixed decision pins; the variable is what a deployment sets. The
  SHAPE halves — a `CORSHandlerPluginOptions` record's headers and methods,
  `ResponseCompressionHandlerPluginOptions`'s `encodings`/`threshold`,
  `plugins` — stay composition-time and reach the handler through `orpc()`'s
  closure, because a record is not something an environment can carry.
  `orpc.ts`'s `pluginsOf(options, config)` is where the two meet, and the oRPC
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

  **CSRF is deliberately NOT here**, and that is the one narrowing of the
  claim below rather than a shipment of it: oRPC's
  `GetMethodCsrfProtectionHandlerPlugin` is meaningful only once a request
  carries a `SameSite` cookie, and this package configures no cookies. It
  becomes an option when cookies do; until then it is a `plugins` line. The
  same reasoning is what keeps `htmx()` (below) carrying no CSRF protection of
  its own **today** — but it is the answerer where the gap will bite first: a
  fragment's `POST` is form-urlencoded, exactly the request shape that skips a
  browser's CORS preflight, so the day a cookie authenticator lands, CSRF stops
  being inert for both answerers at once. Admitting `GET` on an event-iterator
  procedure gives the oRPC answerer its own preflight-free surface now too, so
  both halves will need protecting — and only one of them can be protected by a
  plugin. `GetMethodCsrfProtectionHandlerPlugin` rides `plugins` into
  `RPCHandler`, so it covers oRPC alone; `HtmxOptions` is `{ prefix }` and
  nothing else, so no oRPC plugin ever reaches a fragment and that half has to
  be protected inside this package. Do not write that one plugins line covers
  both — it cannot.

  **`securityHeaders` stays composition-time on purpose** — a deployment that
  can silently turn `x-frame-options` off is a footgun the other three are not.

- **`plugins`** —
  `readonly NodeHttpHandlerPlugin<DefaultInitialContext>[]`, from
  `@orpc/server/node` — any oRPC plugin the three named options do not cover,
  appended to them and forwarded to `new RPCHandler(service, { plugins })`.
  Each of the four threads through all three surfaces on the same
  `...(x === undefined ? {} : { x })` spread every other option here uses —
  `OrpcOptions` (`orpc.ts`) → `HttpOptions` (`http-runtime.ts`)
  → `HttpModuleOptions` (`http-module.ts`) — and needs no generic
  parameter on any of the three, since each is a plain optional field like
  `prefix`. `plugins` is an **honest escape hatch, not a keyhole**: oRPC's
  `StandardHandlerPlugin.init` transforms handler options **including
  `StandardHandlerOptions.interceptors`**, so a plugin can wrap execution and
  an application determined to see a procedure's outcome can get there. What
  the option buys is that the ordinary path is visible configuration at the
  composition root rather than a middleware slot for application logic —
  which is the one thing thesis #3 and the "Not included" bullet below still
  refuse, and reaching past it is a visible act rather than the default shape.
  `principalMiddleware` (see `AUTH.md`) is the one per-request hook this package
  itself installs, and only on a marked leaf.
- **`securityHeaders`** — `boolean | Readonly<Record<string, string>>`,
  default `true`. **Not** routed through `orpc()`: it stays on `HttpOptions`
  after `prefix` and `plugins` are destructured out of `http()`'s options, so
  it lands in `socket` — the rest handed to `httpServer` — and is applied by
  `http-runtime.ts`'s `listen`, on the raw node listener, **before**
  dispatch. That placement, not an oRPC plugin, is deliberate: a plugin only
  runs for a request oRPC **matched**, so the runtime's own `404` and `500`
  would go out bare — the opposite of what helmet-style headers are for.
  `true` applies the package's small default set
  (`x-content-type-options: nosniff`, `x-frame-options: DENY`,
  `referrer-policy: no-referrer`); `false` disables the feature; a record
  replaces the defaults outright. Resolved once per `listen` call, outside
  the per-request `createServer` callback, and set as its **first**
  statement — before `open.add(response)` — so it covers a served response,
  the runtime's `404`, its `500`, and a drained/retired response alike.
  `HttpModuleOptions.securityHeaders` (`http-module.ts`) forwards it to
  `http()` on the same `...(x === undefined ? {} : { x })` spread every
  other option here uses.
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
  `examples/order-api/src/needs-gate.test-d.ts` pins both, plus the
  `StartOptions.unit` halves. **`UNSATISFIED RUNTIME PORTS` is live for this
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
  against a bare listener. A defect
  that never reaches the listener's promise — a synchronous throw, a
  `StartOptions.unit` provider failing to build — gets its `500` from the
  unit's `recoverDefect`, which destroys the socket only once headers are
  already out.
- **The guarantee**: the unit's lifetime **is** the response's — it does not
  close until the response's `'close'` event fires, and closes at once if that
  event already fired before the work ran (a client hanging up during a slow
  `StartOptions.unit` build; the unit's work is deferred behind the fork) — so
  there is no seam for a late write to land in, and `id: randomUUID()` is
  minted per request (a non-blank inbound `x-request-id` becomes `traceId`),
  so the two contracts a runtime owes are structural here rather than left to
  a caller's care.
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
  `plugins` (above) is an honest escape hatch rather than a keyhole — a plugin
  can reach `StandardHandlerOptions.interceptors` and therefore a procedure's
  execution — but the ordinary path is visible configuration at the
  composition root, and an application middleware acting on the handler's
  `Result` is what stays refused.
- Peer dependencies: `@btravstack/core`, `@btravstack/config`,
  `@btravstack/di`, `@btravstack/contract`, `unthrown`, `@orpc/server`,
  `@orpc/contract`, `@unthrown/orpc`. `@btravstack/contract` is a peer for the
  same dual-copy reason as the rest: its marker is a `unique symbol` and two
  copies of the package are two different symbols, so a contract marked
  against one would read as unmarked here. Hono and `@hono/node-server` were peers until the second
  code review of PR #40: Hono routed exactly one pattern (`${prefix}/*`) to
  oRPC's fetch adapter and 404'd the rest, which `@orpc/server/node`'s
  `RPCHandler.handle(req, res, { prefix })` plus the runtime's own `404` do
  with two dependencies fewer — and no `overrideGlobalObjects` footgun to
  disarm.
- **`httpServer({ port?, hostname?, cors?, bodyLimit?, compression?, securityHeaders? })`
  → `Module<HttpRuntime | HttpConfig | HttpHandler, ConfigInvalid, Env>`** — the
  socket half: the runtime, its config, and no answerer. `http()` is
  `Module("Http")({ imports: [httpServer(options)], provides: [orpc(options)],
exports: [HttpRuntime, HttpConfig, HttpHandler] })` — this plus `orpc()`. The
  package's own transport specs, and a fragments-only graph, compose
  `httpServer` directly, with no oRPC router anywhere: a set port makes a
  single answerer welded to the socket the wrong default, and a fragments-only
  application would otherwise have to compose `http()` and declare an oRPC
  router it does not have. `httpRuntime`, the runtime value's factory, stays
  internal.
- **`htmx({ prefix? })` → a `Provider.member(HttpHandler)` over
  `{ fragments: HtmxFragmentsPort, config: HttpConfig }`** (`htmx.ts`) — the
  second answerer: fragments, mounted under `prefix` (default `/`). It
  matches a request against `fragments.routes` by method and path, resolves
  the principal through `resolvePrincipal` when the route carries a
  requirement, reads and validates a `POST` body against the route's own
  schema, and calls the route's `handle`, writing the returned `Html`'s value
  with `content-type: text/html; charset=utf-8`. A request no route claims
  resolves unwritten, exactly like oRPC's answerer, so the runtime's own
  `404` answers it. `cors` and `compression` are oRPC plugins with no
  fragment-answerer equivalent — only `bodyLimit`, read off the same
  `HttpConfig` `orpc()` reads, applies here.

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

- **`resolvePrincipal(requirements, authenticators, headers)`
  → `AsyncResult<unknown, Unauthenticated | UnderScoped>`** — the authentication
  walk, protocol-neutral, shared by every answerer so a scope check cannot drift
  between protocols. `principalMiddleware` is oRPC's adapter over it and keeps
  the throw at the boundary that demands one. `UnderScoped` is the `403` case,
  distinct from `Unauthenticated`'s `401`.

## The two authenticators that ship

The seam was here and none of the implementations were, so every application
wrote the same four things by hand — and this is the one area of the framework
where "the application writes it" carries a security cost rather than a
keystroke cost (issue #157). Two ship; the full surface is in `AUTH.md`.

**`apiKeyAuthenticator`** is on the main entry point, because it has no peer to
be optional about. What it owns is the constant-time compare: SHA-256 digests
rather than strings (`===` leaks a prefix through timing, and `timingSafeEqual`
refuses unequal lengths, which would leak the key's length instead), every key
checked with no early return, and a missing header on the same path as a wrong
one.

**`jwtAuthenticator`** is behind `@btravstack/http-server/jwt` with `jose` an
optional peer — the `@btravstack/observability/pino` protocol. JWKS fetch,
cache and rotation; an allowlist that is asymmetric-only, because a JWKS
publishes PUBLIC keys and accepting `HS256` beside them is the
algorithm-confusion attack; `iss`, `aud` and `exp` required to be
PRESENT through jose's `requiredClaims` — it validates `exp` only when the claim
is there, so without that a signed token omitting it authenticates and never
expires, which `jwt.spec.ts` now pins. `nbf` is honoured when present and not
required: real issuers often omit it. Clock tolerance defaults to zero. Every failure is one refusal, so the endpoint is
not an oracle for which check the attacker got wrong. There is a test that
mints the confusion token and a test that mints one signed by a key the JWKS
does not publish.

**`jose` is ESM-only, and that lands on ONE subpath under ONE module format.**
The CJS build's `require("jose")` needs `require(esm)`, on by default from Node
22.12; ESM is fine on any Node 22, and a consumer that never imports
`@btravstack/http-server/jwt` is unaffected either way. So it is documented
where the subpath is, rather than paid for by raising the package's `engines`
floor from `>=22` — which is a breaking change for every consumer, to serve the
CJS ones on 22.0–22.11.

**A declared vocabulary must be grantable, and the way to guarantee that is to
stop declaring it twice.** Both authenticators take the curried `<P>()(…)` shape
`HttpAuthenticator` already uses — the principal stated, the vocabulary
INFERRED: from `scopes` on the JWT side, from the union of what the keys grant
on the API-key side. A vocabulary written separately from what is granted can
name a scope nothing issues, which passes `ScopeGate` and then refuses every
caller with a permanent 403 — the failure that gate exists to catch, walked past
one layer down. Inference deletes the second place it could be written.

The API-key scheme is scoped when ANY key grants something, decided once at
composition so the answer's shape cannot vary per key: a scoped scheme whose
matched key declared nothing answers an empty grant, never a bare identity.

**No new checking surface.** A grant goes through `granted()` and the existing
walk produces the 403 — which is why `scopes` is a vocabulary and the grant is
its INTERSECTION with the token's claim: a token claiming a scope the scheme
does not know grants nothing extra, and nothing had to learn a second way to
compare.

**Password hashing and credential ISSUING are declined, not deferred.** Both of
these are on the verifying side. Issuing needs somewhere to put a credential
and a session to carry it, and this package configures no cookies and has no
sessions (#160) — so a hasher here would be a primitive with nothing calling
it. `argon2` directly, at whatever mints your tokens, is one dependency and no
framework opinion, which is the right size for it.

## `openApiDocument` — from `@btravstack/http-server/openapi`

**`openApiDocument(contract, { base?, securitySchemes? })` →
`AsyncResult<OpenApiDocument, never>`** (`openapi.ts`) — the contract as an
OpenAPI document, with the `@btravstack/contract` marker folded into each
operation's `security`. Async, and cannot fail — thesis #6's spelling — through
`fromSafePromise`: a generator fault is a defect, never a raw rejection. Both
options are typed by the library per the passthrough rule: `base` is
`Partial<OpenApiDocument>` and `securitySchemes` is `OpenApiSecuritySchemes`,
the document's own `components.securitySchemes` shape reached by index off
`OpenApiDocument` (exported for the same TS4023 reason as the alias itself), so
a key the generator would ignore is a type error rather than silently inert.

**It is a fold, not a translation**, and that is the whole reason this was
cheap: `Requirement` is `Readonly<Record<string, readonly string[]>>` and
`Requirements` an array of them — byte-identical to OpenAPI's
`SecurityRequirementObject[]`, where keys within one object are AND and separate
objects are OR. That correspondence is why `@btravstack/contract` refuses a
two-scheme requirement it would otherwise run as OR, and it means the emitted
`security` is the marker's value with nothing reinterpreted.

**So a document from this stack carries OR and never AND**, because AND cannot
be expressed a layer earlier: the contract refuses the multi-key requirement
OpenAPI would read as AND. An earlier revision of the spec asserted an AND
round-trip and the compiler refused it, which is the two packages agreeing.

**Operations are matched by `operationId`.** `@orpc/openapi` defaults it to the
router segments joined by `.` — measured, not assumed — which is the same
dotted path the contract tree gives, so the walk keys on the contract's own
path rather than on the document's shape.

**`securitySchemes` is the caller's**, because the contract deliberately does
not say what a scheme IS. That is the same split as
`defineHttp({ authenticators })`, one layer out: `auth.ts` says what `user`
resolves to for the server, the document says what it looks like to a client.
A scheme named by the contract with no definition still appears in `security` —
a visible unresolvable reference beats a silently dropped requirement.

**`OpenApiDocument` is exported so a consumer can name it.** Its constituent
types come from `@hey-api/spec-types`, a transitive dependency nothing here
depends on directly, so an application annotating nothing gets TS4023 in its own
declaration emit — measured on `examples/order-api`, the same hazard that shapes
`OrpcRouterPort` and `@btravstack/prisma`'s port.

**Nothing serves it, deliberately.** This package mounts no documentation route
and ships no UI asset: a Swagger UI bundle in a transport package would be a
runtime dependency for every consumer, including the ones who never ask for a
document. An application serves the value from a route of its own —
`examples/order-api/src/openapi.ts` is the whole recipe.

`@orpc/openapi` and `@orpc/json-schema` are **optional peers behind the
subpath**, so a consumer that never imports it installs neither.
`StandardJsonSchemaConverter` is what converts the schemas, and it is why no
`@orpc/zod` is needed: zod v4 is Standard Schema, and `@orpc/zod` publishes no
`2.0.0-beta.28` to match the catalog's pin anyway.

## Internal seam

- **`HttpHandler` is NOT internal any more** — it is the set port of
  **Several answerers, one runtime** below, exported from `index.ts` because a
  second protocol's package has to name what it contributes to. What stays
  internal is the oRPC answerer's own wiring: `orpc.ts`'s `orpc({ prefix })` is
  a `Provider.member(HttpHandler)({ router: OrpcRouterPort, config: HttpConfig
}, …)` answering `{ prefix, handle }`, where `handle` is `@orpc/server/node`'s
  `RPCHandler` — `(request, response) => rpc.handle(request, response, {
prefix })`, unmatched → resolves unwritten. `handle` returns
  `PromiseLike<unknown>` rather than `void` because the package must know when
  an answerer is finished to write a `404` over a declined request without
  racing a response still in flight; `unknown` because oRPC's `handle` resolves
  `{ matched }`, never the unit's result — and the runtime reads "did you
  answer?" off the response rather than off that, which is what lets an
  answerer be written against `node:http` alone.
- **112 specs, 100% lines/functions, across ten spec files.** Every app boots through the `boot`
  fixture — `@btravstack/testing`'s `bootFixture()`, which `serve`, `rpc`,
  `configured` and `appOnPort` depend on — so it is stopped when the test
  ends, on every exit path, and the teardown is Defect-only: a startup
  failure (`configured`'s `ConfigInvalid`, `occupied`'s port in use) is the
  test's to assert on `app.exited`. `http-runtime.spec.ts` carries 24,
  through `test-fixtures.ts`'s `appOf` — `httpServer({ port: 0, hostname:
"127.0.0.1" })` imported next to `answering(handler)` in `provides`,
  `answering` being the fixture that mounts a bare handler as the graph's one
  answerer — so the
  guarantees (`404`/`500` fallbacks, the unit open until `'close'`, the drain,
  streamed responses, keep-alive retirement, the trace-id policy, port
  failures) are exercised with no router in the way, and one more — "serves a
  fragments-only graph, with no oRPC router anywhere" — boots `httpServer()` next
  to `htmx()` alone, pinning that the socket half needs no oRPC answerer wired
  in at all; three of them are the
  starter's config (_"binds PORT and HOST from the environment when nothing is
  pinned"_, _"pins what it is given and reads the rest from the environment"_,
  _"fails startup with ConfigInvalid for HttpConfig when PORT is not a port"_,
  through the `configured` fixture, whose `BoundConfig` provider captures what
  the graph bound), and four of them are `securityHeaders`: the defaults on a
  served response through `serve`, the same defaults on the runtime's own
  `404` through `rpc` — the path a handler plugin would never reach — their
  absence when `securityHeaders: false` is pinned, and a **custom record**
  applied verbatim (the given headers on the response and the defaults gone,
  since the record replaces them rather than extending them), `serve`'s third
  argument threading straight into `appOf`. `orpc.spec.ts` carries 18. Eight
  are the starter proper answers
  for, through the `rpc` fixture — `HttpModule("RpcApp")({ router:
greetingRouter, port: 0, hostname: "127.0.0.1", provides: [Greeter] })` over
  a router provider that declares a `Greeter`, with a typed `RPCLink` client:
  dependencies injected, a nested procedure, a stray implementation key
  dropped, `prefix` honoured, the runtime's 404 outside and under the prefix,
  and oRPC's `INTERNAL_SERVER_ERROR` collapse — plus one through `rpcWithCors`,
  a `greet`-only router configured with oRPC's own `CORSHandlerPlugin`, proving
  `plugins` reaches `RPCHandler` rather than being silently accepted and
  dropped: the plugin, not this package, decided the response's
  `access-control-allow-origin`. The other ten are `cors`/`bodyLimit`/`compression`:
  reflecting the request's origin by default and taking a given `cors` record
  instead, rejecting a body over `DEFAULT_BODY_LIMIT` and over a given limit,
  reading an unbounded body when the limit is pinned off, compressing a
  response when `compression` is enabled and taking given compression
  options, reading the body limit and CORS origin from `HTTP_BODY_LIMIT`/`HTTP_CORS_ORIGIN`
  and compression from `HTTP_COMPRESSION` when nothing is pinned, and preferring the
  option over the environment per field — the same precedence
  `http-runtime.spec.ts`'s config tests pin for `PORT`/`HOST`, proved here for
  the three fields `orpc()` owns instead of `httpServer()`. `controller.spec.ts` carries 6, through the
  `controllers`, `rpcSliced` and `rpcDeep` fixtures: a piece carries the port
  its contract key minted (`OrpcController:greetings`) and the deps it
  declared; `api.OrpcRouter(contract)([...])` serves a router composed from
  two pieces — `helloController` over the `greetings` fragment and
  `echoesController` minted by the dotted path `"echoes.ping"` — with a
  procedure from each answering through one client, proving every piece's
  slice was mounted under the path its port id carries, `nest`'s rebuild
  included; one pins that a router declaring `inject: {}` still has its `sync`
  handed exactly one argument, the empty services record (the former sync-key
  discrimination spec is deleted with the record form: there is no record for a
  `sync` key to be confused with, `Array.isArray` decides); and two are `rpcDeep`, over a contract with two
  pieces sharing the nested `"v1"` parent (`"v1.orders"` and
  `"v1.customers"`) plus one minted at the bare procedure path `"health"` —
  the shared parent is what forces `nest`'s `node[segment] ??=` to find a
  node the first piece already created rather than only ever creating one,
  and `"health"` is the depth-N leaf case, a piece with no fragment around it
  at all. A sixth pins that the rebuild reaches **no prototype**: `nest` builds
  with `Object.create(null)`, because on a plain `{}` a `"__proto__"` segment
  reads `Object.prototype` — not nullish, so `??=` assigns nothing — and the
  walk then writes the piece onto `Object.prototype` itself, corrupting every
  object in the process (measured). `routerOf` only ever `Object.entries` what
  it is handed, so nothing downstream wants the prototype.
  A process still serves one router (thesis #1); the composing
  form changes how many providers build it, not that fact. `auth.spec.ts`
  carries 21, through the `rpcAuthed`, `rpcRootMarked`,
  `rpcRootMarkedDeep`, `controllers` and `headers` fixtures — every router, controller and
  authenticator in them minted by ONE `defineHttp({ authenticators })`,
  since a contract naming no principal leaves the factory as the only way a
  handler gets a readable one. Four are over
  `authedContract` — `{ orders: authenticated({ user: [] })({ whoami }), health: { ping } }`,
  one protected fragment and one public one: the handler reading a `userId`
  only the factory typed, a rejected token answering `UNAUTHORIZED` with the
  handler never entered, an authenticator's own defect collapsing to
  `INTERNAL_SERVER_ERROR` rather than a 401, and an unmarked procedure served
  with no credentials at all. One more is over the authenticator that
  **declares a dependency** — a `Verifier` port, the arm `defineHttp` binds
  through `Provider(port)({ inject, ...arm })` — proving its need travelled with it into
  the graph, and one more is `rpcSubstituted` — the same router with the
  scheme's authenticator replaced on its port, the substitution seam
  `authenticatorPort` exists for. Two are over `rootMarkedContract` —
  `authenticated({ user: [] })({ orders: { whoami } })`, the mark on the **root**, where
  there is no `contract[key]` to read it from: every leaf beneath it is
  protected, and an accepted caller still reaches the
  handler with its principal. Two more are over `rootMarkedDeepContract` — the
  same root mark served through a piece minted **two levels below it**
  (`"v1.orders"`) — the fold-vs-walk proof: an accepted caller reaches the
  piece with its principal and a refused one never enters it, evidence that
  `FragmentAt`'s compile-time fold (applied where the piece is minted) and
  `routerOf`'s runtime `inherited` walk (seeded from the router's own root,
  regardless of how many pieces compose it) type and protect the same leaf.
  Two are composition-time — the scheme's own port
  declared alongside the dependencies the caller wrote, and no scheme port at
  all when the contract marks nothing. The last nine are over the `headers`
  fixture and pin the shared walk's own rules: eight drive
  `principalMiddleware` directly — the first requirement a caller satisfies
  wins, `UNAUTHORIZED` when none is, a granted scope admits, a bare identity
  carrying a `scopes` field injected whole rather than mistaken for a scoped
  grant, `FORBIDDEN` when
  the scheme grants no scopes at all, `FORBIDDEN` when the credential is valid
  but under-scoped, the principal tagged when **one** requirement names two
  schemes, and a defect stopping the walk instead of falling through to the
  next requirement — and the ninth calls `resolvePrincipal` itself rather than
  the middleware, pinning that an under-scoped credential settles the
  protocol-neutral `UnderScoped` tag rather than a bare rejection, which is
  what lets `principalMiddleware`'s `403` and `htmx()`'s `403` both read the
  same distinction off one shared `Err`.
  `controller.test-d.ts` is the package's own compile-time gate — see Public
  surface.

- **`fragments.spec.ts` carries 7**, all for `matchPath` — binding every named
  segment, declining a segment-count mismatch, a literal-segment mismatch, a
  trailing slash that would bind an empty parameter and a malformed
  percent-encoding, and matching a parameter-free pattern and the literal
  root each with an empty (not `undefined`) binding, the distinction
  `htmx.ts`'s "no route matches" check depends on.
- **`html.spec.ts` carries 5**, over `html`/`raw` directly, no app involved:
  every character HTML gives meaning to escaped in both element and quoted
  attribute position, a nested `Html` spliced once rather than escaped twice,
  an array of fragments concatenated with no separator, a hostile
  non-string value's own `toString` output escaped rather than trusted, and
  `raw` as the one way markup survives unescaped.
- **`htmx-route.spec.ts` carries 3**, through the `htmx` fixture's own
  `HtmxFragments` composition over three routes and two schemes: a piece
  carries the port its route's own method and path minted
  (`HtmxFragment:GET /orders/:id/row`) and the deps it declared; the composed
  port carries each route's OWN requirements — two routes requiring "user",
  one requiring "service" — with each scheme key resolving to its OWN
  authenticator, proving a scheme shared across routes cannot resolve to the
  wrong one; and one route's principal and path parameter both reach its own
  piece's handler through `handle`, the answerer's own erased-to-`unknown`
  call shape.
- **`answerers.spec.ts` carries 5**, over a graph composing two bare
  answerers rather than real oRPC or htmx ones, so the routing decision is
  isolated from either protocol: the longest matching prefix wins, a mount
  point itself (not only what is under it) belongs to its own answerer, a
  path no mount covers is the runtime's own `404` with neither answerer
  consulted, a mount point is a path segment rather than a string prefix (a
  sibling path sharing its first characters is not swallowed), and two
  answerers claiming one mount — a trailing slash included — is a
  `RuntimeStartFailed` at `listen` rather than a coin toss.
- **`htmx.spec.ts` carries 19.** Nine are the answerer proper, through the
  `htmxServer` fixture: a GET fragment served with its path parameter bound,
  the `text/html; charset=utf-8` content-type, the runtime's own `404` for a
  path no route declares, a POST on a GET-only path not reaching the GET
  handler (matched by method, not path alone), `401`/`403` for a marked
  route with no credential and one under-scoped, `413` for an over-limit body
  sent across several real TCP chunks — the shape that distinguishes a
  buffer-then-check implementation from `readBody`'s own stream-checking
  one — `422` for a body a route's schema rejects with the handler never
  entered, and the handler reached with the schema's own validated output
  for a body that passes. Three more are over `htmxServer` too: the resolved
  principal reaching a protected route's handler, the unconditional
  `Cache-Control: no-store` on an authenticated response, and an
  authenticator's own defect collapsing to the runtime's `500` rather than a
  `401`. One is the route with no `input` at all, proving the decoded form
  reaches the handler unvalidated. Two drive the built answerer directly,
  past `htmxServer`'s app: a genuine request-stream fault propagating rather
  than being modeled, and a request already destroyed by the time a marked
  route's authentication `await` yields — `readBody`'s own already-fired
  guard, without which the promise never settles. Three are
  composition-level, through `bothProtocols`/`sharedAuth`/`fragmentsOnly`:
  each protocol's own path answering from the one runtime
  `HttpModule({ router, fragments })` starts, a scheme shared by both
  resolving through one authenticator rather than two, and `fragmentsPrefix`
  reaching `htmx()` rather than being silently defaulted to `/`. The last is
  two `HtmxGet` pieces minted on the same method and path refused as di's
  duplicate-provider defect — the route-first sibling of the port-id
  collision `controller.spec.ts` already covers for `OrpcController`.
- **`openapi.spec.ts` carries 4** — pre-dating this feature set, undocumented
  here until now: `openApiDocument` answering through the `Result` channel —
  async and cannot fail, never a raw rejection — a marked procedure's own
  scheme and scopes reaching `security` with an unmarked one carrying none,
  several schemes on one mark round-tripping as one requirement per
  alternative (OpenAPI's own OR — there is no AND case, since
  `@btravstack/contract` refuses the multi-scheme requirement OpenAPI would
  read as AND), and a procedure's own mark shadowing its record's for itself
  while a sibling still inherits the record's.

## Several answerers, one runtime

**`HttpHandler` is a SET port of `{ prefix, handle }`, and each protocol served
in this process contributes one member.** Two ship: oRPC (`orpc()`, from
`http()`) and htmx fragments (`htmx()`, serving `Html`). GraphQL is what the
family is being extended for next (#179). The shape was chosen in #174, and
the reason is a constraint rather
than a preference: **a graph holds exactly one runtime** (thesis #1 — every
runtime port is declared over the kernel's `RuntimePort`, so a graph can hold
exactly one), so three protocols cannot be three runtimes. They are three
answerers under one.

**Routing is by longest matching prefix, and there is no chain.** `/rpc` owns
`/rpc` and everything under it; a `/` fragment answerer takes the rest. Nesting
is the expected shape rather than a conflict, so ordering never has to be
decided — which is the whole reason this beat #174's own option (2), where a
chain of "answer or decline" would have made ordering a property of provider
registration across modules and visible in no single line. A path no mount
point covers is the runtime's own `404`, written before any answerer is
consulted; a path a mount DOES cover, whose answerer declines, is the same
`404` it always was.

Four consequences worth stating because each is a decision:

- **A mount point is a path segment, not a string prefix.** `/rpc` does not own
  `/rpcx`. A trailing slash is the same mount (`/rpc/` and `/rpc` collide), and
  two answerers on one mount is a `RuntimeStartFailed` at `listen` rather than
  a coin toss.
- **The runtime reads the members through `Runtime.resolves`, not through di.**
  A member contributed by a SIBLING module is not visible from inside the
  starter's own module, and `resolves` is the mechanism the kernel already ships
  for "what the runtime reads back out of the built application context". The
  cost is that a composition root must export `HttpHandler`; `HttpModule` does
  it for the application, and `start`'s gate names the port when a hand-written
  root forgets.
- **`HttpHandler` is public now.** It was internal on the stated grounds that
  "there is one way to answer HTTP here, oRPC, so nothing outside this package
  provides or names it". A second protocol's package has to name it, so that
  sentence is gone from `handler.ts`.
- **The socket half composes on its own** (`httpServer`, in **Public surface**
  above). An application serves oRPC (`http()`), fragments (`httpServer()` +
  `htmx()`), or both — the weld between the socket and one answerer was a
  leftover from when there was exactly one.

**An answerer outside a contract carries its own authentication, and nothing
checks that it did.** `@btravstack/contract`'s marker is what says which scheme
protects an oRPC procedure, and `defineHttp({ authenticators })` is what
resolves it. A fragment or GraphQL answerer has no such statement of intent, so
its routes are **public** unless it brings authentication of its own — the same
way an unmarked procedure is public, and with the same absence of a gate for
"you forgot". Do not describe a non-oRPC answerer as protected by the
contract's marker. What the common way across protocols should be is #179's
question and is deliberately not answered here.

## Cross-cutting concerns: configuration, not a middleware slot

CORS, body limits, compression, CSRF, security headers and authentication all
arrive at the same door, and the answer is the same for all of them: **they are
handler configuration, not a middleware slot.** Thesis #3's refusal survives
intact, narrowed to what it was always about.

**Five of the six are configuration; CSRF is the exception, and it is stated
rather than glossed.** `cors`, `bodyLimit` and `compression` are options that
pin `HttpConfig` fields a deployment can set instead; `securityHeaders` is an
option on the listener; authentication is bound through `defineHttp`'s
authenticators, which ride the router rather than being an option on `http()`.
CSRF is reached through `plugins` because oRPC's protection only bites on a
request carrying a `SameSite` cookie and this package configures no cookies —
an option over a cookie surface that does not exist would be configuration
with nothing to configure. The claim used to cover all six while the code
shipped two, which is the drift the root `CLAUDE.md` names as the failure
mode it fears most; if cookies arrive, the exception goes with them. An oRPC plugin and the starter's
own `principalMiddleware` act on the **request/response envelope** — bytes,
headers, a principal resolved before dispatch. An application middleware would
act on the handler's **`Result`**, and that is the only one `@btravstack/http-server`
refuses, because it is the one that would put a use case's outcome in the
transport's hands.

- **`plugins` is an honest escape hatch, not a keyhole.** It forwards straight
  to `new RPCHandler(service, { plugins })`, and an oRPC plugin can reach
  oRPC's interceptors — so an application determined to see a procedure's
  outcome can get there. Nothing pretends otherwise. What the option buys is
  that the ordinary path is configuration a reader can see at the composition
  root, and reaching past it is a visible act rather than the default shape.
- **Security headers are set on the listener, not as a plugin.** A plugin only
  runs for a request oRPC **matched**, so the runtime's own `404` would go out
  bare — the opposite of what helmet-style headers are for.
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

  A **scope** is the exception that proves the rule, and it is admitted on the
  same test: it is a property of the credential, answerable before dispatch,
  which is exactly why authentication is in the contract already. What stays
  out is resource-dependent authorization — the order's owner, the row's tenant
  — which a scope was never going to answer. `@btravstack/http-server` checks a
  credential's granted scopes against the endpoint's declared ones and answers
  `403`, distinct from the `401` a caller with no valid credential gets.

## RED metrics: the runtime records them, because only it can

`btravstack.http.requests` (counter) and `btravstack.http.duration`
(histogram, ms), both dimensioned `{ method, answerer, status }`, recorded at
the unit seam. Every unit is handed to `Observers`, and this module contributes a no-op
member of its own — so a graph composing no observability owes nothing — an operation costs one
inert call per module that reads the port. There is no `instrumented` flag: composing `observability()`
and `otel()` is what turns the lines and the instruments on.

**Recorded on the response's `'close'`, not on the unit settling.** They would
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

`examples/order-api`'s `RequestModule` used to hand-write this histogram, which
was the proof it was missing here. What is left there is the log LINE, which is
that module's actual subject.
