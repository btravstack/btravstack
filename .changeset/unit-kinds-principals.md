---
"@btravstack/http-server": major
---

`defineHttp` mints one principal port per declared scheme, on
`auth.principals`, and a second step `auth.units<{…}>()` retypes the same
object by the module each unit kind binds.

A unit is opened under a KIND — `anonymous`, or the scheme that resolved a
credential — and a kind binds a `Module` whose providers may inject the caller
the unit was opened for. `auth.principals.user` is the port that carries it:
minted from the scheme name alone, typed by the principal that scheme's
authenticator declared, and named by a unit module in its own `needs`.

The kinds arrive on a **second** call for a reason a single call cannot have.
A unit module names `auth.principals.<scheme>`, so its type depends on
`typeof auth`; if `auth` also depended on the modules the kinds bind, the two
would be mutually recursive and TypeScript reports TS7022. `auth.units<U>()`
breaks the loop: `typeof auth` depends on the authenticators alone, and
`units` hands back the very same object under a narrower type — nothing is
rebuilt.

`principalPort(scheme)`, `Principals<A>` and `UnitsOf<A>` are exported.

The piece factories read those kinds. `api.OrpcController(contract, key)` and
`api.OrpcRouter(contract)` both take an optional `unit: { name: Port }` beside
`inject`, declared once, and every leaf reads it as `context.unit.name` — typed
by the KIND that leaf's own requirements select, so a port the kind's module
does not export is not a property and reading it is TypeScript's own
"property does not exist". An unmarked leaf sees `anonymous`'s exports, a
marked one its scheme's, and a leaf accepting several schemes only what every
one of their modules exports. A scheme that binds no module falls back to
`anonymous` on the type side exactly as it does at runtime. Entries resolve
lazily, on read.

`Implementation<C, Schemes, R>` gains two further parameters,
`Implementation<C, Schemes, R, Units, U>`, both defaulted to the empty record;
a minted piece now carries its declared record as `piece.unit`, the way an
htmx route carries `route`. With `units<…>()` never called, `context.unit` is
`{}` on every leaf and a piece declaring no record compiles unchanged.
