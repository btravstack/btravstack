---
"@btravstack/http-server": minor
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
Nothing existing changes: `Units` defaults to the empty record and is a
phantom on `Http<A, Units>` until the piece factories read it.
