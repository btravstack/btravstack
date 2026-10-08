// The "serves nothing" gate: `HttpModule` composes a router, fragments, or
// both, and refuses a call that supplies neither. A gate that refuses
// everything would pass this file on the negative case alone, so all three
// valid shapes are pinned as positives too. Each `@ts-expect-error` is an
// assertion: if one stops erroring, the gate is gone.
import { authenticated } from "@btravstack/contract";
import { start } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { html } from "@btravstack/htmx-server";
import { HttpAuthenticator } from "@btravstack/http-server";
import { oc } from "@orpc/contract";
import { OkAsync } from "unthrown";

import { defineHttp } from "./define-http.js";
import { HttpModule } from "./http-module.js";
import { http } from "./http.js";

const api = defineHttp();

const contract = oc.router({ hello: oc });
const router = api.OrpcRouter(contract)({
  inject: {},
  sync: () => ({ hello: () => OkAsync("hi") }),
});

const rowFragment = api.HtmxGet("/row")({
  inject: {},
  sync: () => () => OkAsync(html`<p>row</p>`),
});
const fragments = api.HtmxFragments([rowFragment]);

// @ts-expect-error — neither `router` nor `fragments` is supplied
void HttpModule("Neither")({ port: 0 });

void HttpModule("RouterOnly")({ router, port: 0 });

void HttpModule("FragmentsOnly")({ fragments, port: 0, provides: [rowFragment] });

void HttpModule("Both")({ router, fragments, port: 0, provides: [rowFragment] });

// The `unit` needs-propagation gate: a bound `unit.anonymous` module's own
// unmet needs join `HttpModule`'s own Needs channel (an import's own unmet
// needs are not `HttpModule`'s OWN call to re-declare — di's `NeedsGate`
// TSDoc), so the gate that refuses them is `start`'s ordinary
// `UNSATISFIED DEPENDENCIES`, never a marker of the kernel's.
const startOptions = { signals: false, probes: false } as const;
class UnitDep extends Port("UnitModuleTypeDDep")<{ readonly value: number }> {}
class UnitSpan extends Port("UnitModuleTypeDSpan")<{ readonly at: number }> {}
const UnitModule = Module("UnitModuleTypeD")({
  needs: [UnitDep],
  provides: [
    Provider(UnitSpan)({ inject: { dep: UnitDep }, sync: ({ dep }) => ({ at: dep.value }) }),
  ],
  exports: [UnitSpan],
});

const _withUnitSatisfied = start(
  HttpModule("WithUnitSatisfied")({
    router,
    port: 0,
    unit: { anonymous: UnitModule },
    provides: [Provider(UnitDep)({ inject: {}, value: { value: 1 } })],
  }),
  startOptions,
);
void _withUnitSatisfied;

const _unloggedUnit = HttpModule("WithUnitUnmet")({
  router,
  port: 0,
  unit: { anonymous: UnitModule },
});
// @ts-expect-error — UNSATISFIED DEPENDENCIES: nothing provides `UnitDep`, which `UnitModule` needs
const _withUnitUnmet = start(_unloggedUnit, startOptions);
void _withUnitUnmet;

// The same gate over a SCHEME's kind, and the subtraction that makes it usable:
// a kind's module may name its own scheme's principal port, which the fork
// seeds — so it must NOT surface as an unmet need, while everything else the
// module owes still must.
const withUser = defineHttp({
  authenticators: {
    user: HttpAuthenticator<{ readonly userId: string }>()({
      inject: {},
      sync: () => () => OkAsync({ userId: "u-1" }),
    }),
  },
});

// Marked, so `user` is a kind a request can open under: the root's own gate
// (case 2, below) reads the bindable set off the schemes the contract names.
const userContract = { me: authenticated({ user: [] })({ hello: oc }) };
const userRouter = withUser.OrpcRouter(userContract)({
  inject: {},
  sync: () => ({ me: { hello: () => OkAsync("hi") } }),
});

const UserUnitModule = Module("UserUnitTypeD")({
  needs: [withUser.principals.user, UnitDep],
  provides: [
    Provider(UnitSpan)({
      inject: { principal: withUser.principals.user, dep: UnitDep },
      sync: ({ principal, dep }) => ({ at: principal.userId.length + dep.value }),
    }),
  ],
  exports: [UnitSpan],
});

const _withKindSatisfied = start(
  HttpModule("WithKindSatisfied")({
    router: userRouter,
    port: 0,
    unit: { anonymous: UnitModule, user: UserUnitModule },
    provides: [Provider(UnitDep)({ inject: {}, value: { value: 1 } })],
  }),
  startOptions,
);
void _withKindSatisfied;

const _unloggedKind = HttpModule("WithKindUnmet")({
  router: userRouter,
  port: 0,
  unit: { user: UserUnitModule },
});
// @ts-expect-error — UNSATISFIED DEPENDENCIES: `UnitDep` still surfaces, where the seeded principal does not
const _withKindUnmet = start(_unloggedKind, startOptions);
void _withKindUnmet;

// The subtraction on its own: a kind's module owing NOTHING but its scheme's
// principal starts with no provider at all. Without `Exclude<…,
// PrincipalInstance>` this line is an `UNSATISFIED DEPENDENCIES` error.
const PrincipalOnlyUnit = Module("PrincipalOnlyUnitTypeD")({
  needs: [withUser.principals.user],
  provides: [
    Provider(UnitSpan)({
      inject: { principal: withUser.principals.user },
      sync: ({ principal }) => ({ at: principal.userId.length }),
    }),
  ],
  exports: [UnitSpan],
});

const _principalOnly = start(
  HttpModule("PrincipalOnly")({ router: userRouter, port: 0, unit: { user: PrincipalOnlyUnit } }),
  startOptions,
);
void _principalOnly;

// The subtraction is PER KIND: a fork seeds only the principal of the scheme
// that resolved, and `anonymous` none at all — so a principal any other kind's
// module names stays an unmet need rather than a request that answers `500`.
const _anonymousNeedsPrincipal = HttpModule("AnonymousNeedsPrincipal")({
  router: userRouter,
  port: 0,
  unit: { anonymous: PrincipalOnlyUnit },
});
// @ts-expect-error — UNSATISFIED DEPENDENCIES: an anonymous unit is seeded with no principal
const _anonymousPrincipal = start(_anonymousNeedsPrincipal, startOptions);
void _anonymousPrincipal;

const withTwo = defineHttp({
  authenticators: {
    user: HttpAuthenticator<{ readonly userId: string }>()({
      inject: {},
      sync: () => () => OkAsync({ userId: "u-1" }),
    }),
    service: HttpAuthenticator<{ readonly serviceId: string }>()({
      inject: {},
      sync: () => () => OkAsync({ serviceId: "s-1" }),
    }),
  },
});
const twoRouter = withTwo.OrpcRouter({
  me: authenticated({ user: [] })({ hello: oc }),
  ops: authenticated({ service: [] })({ ping: oc }),
})({
  inject: {},
  sync: () => ({ me: { hello: () => OkAsync("hi") }, ops: { ping: () => OkAsync("pong") } }),
});
const ServiceOnlyUnit = Module("ServiceOnlyUnitTypeD")({
  needs: [withTwo.principals.service],
  provides: [
    Provider(UnitSpan)({
      inject: { principal: withTwo.principals.service },
      sync: ({ principal }) => ({ at: principal.serviceId.length }),
    }),
  ],
  exports: [UnitSpan],
});

const _serviceSeeded = start(
  HttpModule("ServiceSeeded")({ router: twoRouter, port: 0, unit: { service: ServiceOnlyUnit } }),
  startOptions,
);
void _serviceSeeded;

const _mismatchedScheme = HttpModule("MismatchedScheme")({
  router: twoRouter,
  port: 0,
  unit: { user: ServiceOnlyUnit },
});
// @ts-expect-error — UNSATISFIED DEPENDENCIES: a `user` unit is seeded with the user principal, never the service one
const _mismatched = start(_mismatchedScheme, startOptions);
void _mismatched;

// The root's `unit` gate, case 1: the router carries the kinds `units<…>()`
// declared, so a bound value must BE the module that kind declared and a kind
// outside the declaration is refused.
const AnonymousUnit = Module("GatedAnonymousTypeD")({
  provides: [Provider(UnitSpan)({ inject: {}, value: { at: 0 } })],
  exports: [UnitSpan],
});
class UnitTenant extends Port("UnitModuleTypeDTenant")<{ readonly id: string }> {}
const UserUnit = Module("GatedUserTypeD")({
  needs: [withUser.principals.user],
  provides: [
    Provider(UnitTenant)({
      inject: { principal: withUser.principals.user },
      sync: ({ principal }) => ({ id: principal.userId }),
    }),
  ],
  exports: [UnitTenant],
});

const gated = withUser.units<{ anonymous: typeof AnonymousUnit; user: typeof UserUnit }>();
const gatedRouter = gated.OrpcRouter(contract)({
  inject: {},
  sync: () => ({ hello: () => OkAsync("hi") }),
});

void HttpModule("GatedDeclared")({
  router: gatedRouter,
  port: 0,
  unit: { anonymous: AnonymousUnit, user: UserUnit },
});

const _wrongModule = {
  router: gatedRouter,
  port: 0,
  unit: { anonymous: AnonymousUnit, user: AnonymousUnit },
} as const;
// @ts-expect-error — the bound module is not the one units<…>() declared for `user`
void HttpModule("GatedWrongModule")(_wrongModule);

const _undeclaredKind = {
  router: gatedRouter,
  port: 0,
  unit: { anonymous: AnonymousUnit, service: AnonymousUnit },
} as const;
// @ts-expect-error — UNDECLARED UNIT KIND: `units<…>()` declared no `service`
void HttpModule("GatedUndeclaredKind")(_undeclaredKind);

// Case 1 again, off the FRAGMENTS: a fragments-only root under a kinded api
// reaches the same gate, because `HtmxFragments` carries the `_units` phantom
// the router does.
const gatedRow = gated.HtmxGet("/row")({
  inject: {},
  sync: () => () => OkAsync(html`<p>row</p>`),
});
const gatedFragments = gated.HtmxFragments([gatedRow]);

void HttpModule("GatedFragmentsDeclared")({
  fragments: gatedFragments,
  port: 0,
  provides: [gatedRow],
  unit: { anonymous: AnonymousUnit, user: UserUnit },
});

const _fragmentsWrongModule = {
  fragments: gatedFragments,
  port: 0,
  provides: [gatedRow],
  unit: { anonymous: AnonymousUnit, user: AnonymousUnit },
} as const;
// @ts-expect-error — the bound module is not the one units<…>() declared for `user`
void HttpModule("GatedFragmentsWrongModule")(_fragmentsWrongModule);

const _fragmentsUndeclaredKind = {
  fragments: gatedFragments,
  port: 0,
  provides: [gatedRow],
  unit: { anonymous: AnonymousUnit, service: AnonymousUnit },
} as const;
// @ts-expect-error — UNDECLARED UNIT KIND: `units<…>()` declared no `service`
void HttpModule("GatedFragmentsUndeclaredKind")(_fragmentsUndeclaredKind);

// Case 1 the other way round: a declared kind the root SERVES must be bound.
// Its leaves are typed by the module `units<…>()` named, and an unbound kind
// forks `anonymous`'s — or nothing — so leaving it out is a leaf reading a
// port its fork never built. A declared kind no answerer serves stays
// optional: `gatedRouter` marks nothing, so it binds `anonymous` alone.
const gatedUserRouter = gated.OrpcRouter(userContract)({
  inject: {},
  sync: () => ({ me: { hello: () => OkAsync("hi") } }),
});

void HttpModule("GatedServedOnly")({
  router: gatedRouter,
  port: 0,
  unit: { anonymous: AnonymousUnit },
});

const _omittedKind = {
  router: gatedUserRouter,
  port: 0,
  unit: { anonymous: AnonymousUnit },
} as const;
// @ts-expect-error — Property 'user' is missing: the router serves a kind `units<…>()` declared
void HttpModule("GatedOmittedKind")(_omittedKind);

const _unboundKinds = { router: gatedUserRouter, port: 0 } as const;
// @ts-expect-error — UNBOUND UNIT KINDS: the router serves kinds `units<…>()` declared
void HttpModule("GatedUnbound")(_unboundKinds);

// `anonymous` is required only when a request here forks it: a public leaf, or
// a served scheme that declared no module of its own and falls back to it. A
// root whose every leaf is authenticated binds its schemes and nothing else.
void HttpModule("GatedAuthenticatedOnly")({
  router: gatedUserRouter,
  port: 0,
  unit: { user: UserUnit },
});

const gatedMixedRouter = gated.OrpcRouter({ ...userContract, open: { hello: oc } })({
  inject: {},
  sync: () => ({ me: { hello: () => OkAsync("hi") }, open: { hello: () => OkAsync("hi") } }),
});
const _publicLeafUnbound = {
  router: gatedMixedRouter,
  port: 0,
  unit: { user: UserUnit },
} as const;
// @ts-expect-error — Property 'anonymous' is missing: `open.hello` is public
void HttpModule("GatedPublicLeafUnbound")(_publicLeafUnbound);

const anonymousOnly = withUser.units<{ anonymous: typeof AnonymousUnit }>();
const fallbackRouter = anonymousOnly.OrpcRouter(userContract)({
  inject: {},
  sync: () => ({ me: { hello: () => OkAsync("hi") } }),
});
const _fallbackUnbound = { router: fallbackRouter, port: 0 } as const;
// @ts-expect-error — UNBOUND UNIT KINDS: `user` declared no module, so it forks `anonymous`'s
void HttpModule("GatedFallbackUnbound")(_fallbackUnbound);

const gatedUserRow = gated.HtmxGet("/me", { requires: [{ user: [] }] })({
  inject: {},
  sync: () => () => OkAsync(html`<p>me</p>`),
});
void HttpModule("GatedFragmentsAuthenticatedOnly")({
  fragments: gated.HtmxFragments([gatedUserRow]),
  port: 0,
  provides: [gatedUserRow],
  unit: { user: UserUnit },
});

// The kinds are read off the EFFECTIVE marks: a `user` mark every procedure
// below it overrides with `service` opens no `user` unit, so `user` stays
// optional though the router still owes its authenticator.
const shadowed = withTwo.units<{ user: typeof AnonymousUnit; service: typeof ServiceOnlyUnit }>();
const shadowedRouter = shadowed.OrpcRouter(
  authenticated({ user: [] })({ ops: authenticated({ service: [] })({ ping: oc }) }),
)({
  inject: {},
  sync: () => ({ ops: { ping: () => OkAsync("pong") } }),
});
void HttpModule("ShadowedMarkOptional")({
  router: shadowedRouter,
  port: 0,
  unit: { service: ServiceOnlyUnit },
});

const _shadowedUnbound = { router: shadowedRouter, port: 0 } as const;
// @ts-expect-error — UNBOUND UNIT KINDS: the effective `service` mark still opens a unit
void HttpModule("ShadowedMarkUnbound")(_shadowedUnbound);

// A router and fragments from two `units<…>()` calls declaring different kinds
// cannot share one binding: `fallbackRouter` types its `user` leaf against
// `anonymous`'s module, and binding `user` for the fragments would fork
// `UserUnit` under it. Refused; one declaration for both composes.
const _divergent = {
  router: fallbackRouter,
  fragments: gated.HtmxFragments([gatedUserRow]),
  port: 0,
  provides: [gatedUserRow],
  unit: { anonymous: AnonymousUnit, user: UserUnit },
} as const;
// @ts-expect-error — DIVERGENT UNIT KINDS: `fallbackRouter`'s declaration has no `user`
void HttpModule("DivergentDeclarations")(_divergent);

void HttpModule("OneDeclaration")({
  router: gatedUserRouter,
  fragments: gated.HtmxFragments([gatedUserRow]),
  port: 0,
  provides: [gatedUserRow],
  unit: { user: UserUnit },
});

const _fragmentsUnbound = { fragments: gatedFragments, port: 0, provides: [gatedRow] } as const;
// @ts-expect-error — UNBOUND UNIT KINDS: the fragments serve `anonymous`, which was declared
void HttpModule("GatedFragmentsUnbound")(_fragmentsUnbound);

// Case 2: a plain `defineHttp` api declares no kinds, so the bindable set is
// `anonymous` plus every scheme the answerers serve — which is what keeps
// `examples/order-api`'s `unit: { anonymous }` compiling while refusing a typo.
void HttpModule("PlainAnonymousOnly")({
  router: userRouter,
  port: 0,
  unit: { anonymous: UnitModule },
});

void HttpModule("PlainBothKinds")({
  router: userRouter,
  port: 0,
  unit: { anonymous: UnitModule, user: PrincipalOnlyUnit },
});

const _typoedKind = {
  router: userRouter,
  port: 0,
  unit: { anonymous: UnitModule, usre: UnitModule },
} as const;
// @ts-expect-error — UNDECLARED UNIT KIND: `usre` is no scheme the contract names
void HttpModule("PlainTypoedKind")(_typoedKind);

// `csrf` is one option on both surfaces — the same field `HttpOptions` carries
// to `http()` — and it is a boolean or nothing, never a policy record somebody
// half-remembers from `cors`.
void HttpModule("CsrfPinnedOn")({ router, port: 0, csrf: true });
void HttpModule("CsrfPinnedOff")({ router, port: 0, csrf: false });
void http({ csrf: true });
void http({ csrf: false });
void http({});

const _csrfNotABoolean = { router, port: 0, csrf: "same-origin" } as const;
// @ts-expect-error — `csrf` is a boolean; the policy is not configurable per origin
void HttpModule("CsrfNotABoolean")(_csrfNotABoolean);

// @ts-expect-error — the same on `http()`, which takes the identical option type
void http({ csrf: "same-origin" });
