---
"@btravstack/contract": minor
"@btravstack/http": minor
---

Let a contract name **which security schemes** a procedure accepts and **which
scopes** each must grant, and let an application say what each scheme resolves
to — in one call.

`@btravstack/contract`'s marker carries OpenAPI's own requirement shape instead
of a boolean. `authenticated` is now **curried**:
`authenticated(...requirements)(node)`, where a `Requirement` is
`Readonly<Record<string, readonly string[]>>` — a scheme name mapped to the
scopes it must grant. Several requirements are **ORed**, tried in declaration
order. Applied to a record it is the default for every procedure beneath it;
applied to a procedure it **replaces** that default for itself — nearest mark
wins, which is OpenAPI's rule. `isAuthenticated(node)` answers
`Requirements | undefined` rather than a boolean, `Authenticated<T, R>` and the
new `RequirementsOf<T>` carry the exact requirements at the type level, and the
registry is a `WeakMap` under `Symbol.for("@btravstack/contract/requirements")`
— a new key, so a mismatched copy of the package reads a node as _unmarked_ and
fails closed rather than calling `.has()` on it and getting an accidentally
correct answer.

`@btravstack/http` gains **`defineHttp`**, the one door:

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
credential reports what it actually granted (`Granted<P, Scope>` is `P` bare
when there is no vocabulary) and the starter compares it against what the
endpoint declared: a valid credential lacking a required scope is **`403`**,
no valid credential at all is **`401`**, and neither carries a message. A
`Defect` from an authenticator short-circuits rather than falling through to
the next scheme — a broken verifier must not promote every caller.

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
