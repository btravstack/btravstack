// The type half of the auth surface: a marked contract node types its handler's
// principal on oRPC's own context channel from the requirements it names, and
// an unmarked one does not. Each `@ts-expect-error` is an assertion: if one
// stops erroring, the gate is gone.
import { Env } from "@btravstack/config";
import { authenticated, type Authenticated } from "@btravstack/contract";
import { start } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { oc } from "@orpc/contract";
import { ErrAsync, OkAsync } from "unthrown";
import { expectTypeOf } from "vitest";

import { HttpAuthenticator, Unauthenticated, granted } from "./auth.js";
import { defineHttp } from "./define-http.js";
import { HttpModule } from "./http-module.js";
import type { HasMark, Implementation } from "./orpc.js";

type Identity = { readonly userId: string; readonly tenantId: string };
type ServiceIdentity = { readonly appId: string };

const contract = {
  orders: authenticated({ user: [] })({ place: oc }),
  health: { ping: oc },
  quote: authenticated({ user: [] }, { service: [] })(oc),
};

/** Two schemes, so the tagged principal and the bare one are both in play. */
const api = defineHttp({
  authenticators: {
    user: HttpAuthenticator<Identity>()({
      sync: () => () => OkAsync({ userId: "u", tenantId: "t" }),
    }),
    service: HttpAuthenticator<ServiceIdentity>()({
      sync: () => () => OkAsync({ appId: "a" }),
    }),
  },
});

type Schemes = { readonly user: Identity; readonly service: ServiceIdentity };

type Expect<T extends true> = T;
type HandlerContext<H> = H extends (opts: infer O, ...rest: never) => unknown
  ? O extends { readonly context: infer Ctx }
    ? Ctx
    : never
  : never;

type OrdersImpl = Implementation<(typeof contract)["orders"], Schemes>;
type HealthImpl = Implementation<(typeof contract)["health"], Schemes>;
type QuoteImpl = Implementation<(typeof contract)["quote"], Schemes>;

// 1. A marked RECORD pushes its requirements onto every procedure beneath it,
//    and the scheme's identity arrives on `opts.context` — oRPC's own channel,
//    no second handler parameter added by this package. One scheme, so it is
//    the identity bare.
declare const ordersContext: HandlerContext<OrdersImpl["place"]>;
const _inherited: Identity = ordersContext.principal;

// 2. A marked PROCEDURE protects itself, and two requirements make the
//    principal a discriminated union rather than a widened guess.
declare const quoteContext: HandlerContext<QuoteImpl>;
expectTypeOf(quoteContext.principal).toEqualTypeOf<
  | { readonly scheme: "user"; readonly identity: Identity }
  | { readonly scheme: "service"; readonly identity: ServiceIdentity }
>();

// 3. The marker's phantom key never becomes a procedure key.
type _OrdersKeys = Expect<
  [keyof OrdersImpl] extends ["place"]
    ? ["place"] extends [keyof OrdersImpl]
      ? true
      : false
    : false
>;

// 4. An unmarked procedure's context carries no principal.
declare const healthContext: HandlerContext<HealthImpl["ping"]>;
// @ts-expect-error — `principal` is not on an unmarked handler's context
const _none: Identity = healthContext.principal;

// 5. `HasMark` finds a mark through the nesting, and is EXACTLY `true` — a
//    `boolean` result would satisfy both this assertion and its opposite.
type _Marked = Expect<
  [HasMark<typeof contract>] extends [true]
    ? [true] extends [HasMark<typeof contract>]
      ? true
      : false
    : false
>;

// 6. An all-public contract is exactly `false`, on the same footing.
type _Unmarked = Expect<
  [HasMark<{ readonly health: { readonly ping: typeof oc } }>] extends [false]
    ? [false] extends [HasMark<{ readonly health: { readonly ping: typeof oc } }>]
      ? true
      : false
    : false
>;

void _inherited;
void _none;

// The composition half. Declaring a scheme and implementing it are now the same
// act, so there is no authenticator to forget and no identity pair to compare —
// what is left is di's own unmet need, on the port whose id carries the scheme
// name.
const markedRouter = api.HttpRouter({ orders: contract.orders, health: contract.health })({
  sync: () => ({
    orders: { place: ({ context }) => OkAsync({ id: context.principal.userId }) },
    health: { ping: () => OkAsync({ ok: true as const }) },
  }),
});

const options = { signals: false, probes: false } as const;

// 7. The application lists no authenticators: the sugar carries them in from
//    the same call that declared the schemes, so this is the whole root.
const WiredApi = HttpModule("Wired")({ needs: [Env], router: markedRouter });
const _wired = start(WiredApi, options);

// 8. `authenticator` is gone as an option — schemes come from `defineHttp`.
void HttpModule("Rejected")({
  needs: [Env],
  router: markedRouter,
  // @ts-expect-error — there is no `authenticator` option any more
  authenticator: HttpAuthenticator<Identity>()({
    sync: () => () => OkAsync({ userId: "u", tenantId: "t" }),
  }),
});

void _wired;

// 9. A contract naming a scheme the registry has no authenticator for is
//    refused, and it is refused as an ORDINARY unmet need on that scheme's own
//    port — not a gate this package writes. `defineHttp()` declares nothing, so
//    `HttpAuthenticator:user` reaches nobody.
const openApi = defineHttp();
const strandedFragment = { orders: authenticated({ user: [] })({ place: oc }) };
const strandedRouter = openApi.HttpRouter(strandedFragment)({
  // The handler reads no principal — under `defineHttp()` it would be `never`.
  sync: () => ({ orders: { place: () => OkAsync({ id: "o-1" }) } }),
});
// @ts-expect-error — UNDECLARED NEEDS: nothing discharges `HttpAuthenticator:user`
void HttpModule("Stranded")({ needs: [Env], router: strandedRouter });

// 10. A ROOT-marked contract composes through the KEYED form, and a controller
//     under it reads the identity its scheme resolves. The keyed overload must
//     therefore `Exclude` the phantom key from the keys it demands (or the
//     record can never be complete) and `Inherit` the root's requirements down
//     to each fragment (or no controller under it could type
//     `context.principal`) — both of which the deps arm already did.
//     `contract.orders` above marks a KEY, so neither omission showed there.
declare const ordersFragment: Authenticated<
  { readonly whoami: typeof oc },
  [{ readonly user: readonly [] }]
>;
const rootOrders = api.HttpController(
  "RootOrders",
  ordersFragment,
)({
  sync: () => ({ whoami: ({ context }) => OkAsync(context.principal.userId) }),
});
const rootMarkedContract = authenticated({ user: [] })({ orders: { whoami: oc } });
const _rootKeyed = HttpModule("RootKeyed")({
  needs: [Env],
  router: api.HttpRouter(rootMarkedContract)({ orders: rootOrders }),
  // The controller is provided too: the keyed router depends on its PORT, and
  // a root that names no slice still owes it.
  provides: [rootOrders],
});

void _rootKeyed;

// 11. An authenticator that DECLARES DEPENDENCIES is the documented shape — a
//     JWT verifier, a key set, a user directory. Its own need travels with it
//     into `provides`, so a root that imports nothing satisfying it is refused
//     at THIS call by di's `NeedsGate`, exactly as a hand-listed provider would
//     be. That is what carrying the authenticators on the router has to buy.
class Verifier extends Port("Verifier")<(token: string) => Identity | undefined> {}

const verifying = defineHttp({
  authenticators: {
    user: HttpAuthenticator<Identity>()(
      { verify: Verifier },
      {
        sync:
          ({ verify }) =>
          (headers) => {
            const claimed = verify(headers.authorization ?? "");
            return claimed === undefined ? ErrAsync(new Unauthenticated()) : OkAsync(claimed);
          },
      },
    ),
  },
});

const verifiedRouter = verifying.HttpRouter({ orders: contract.orders })({
  sync: () => ({ orders: { place: ({ context }) => OkAsync({ id: context.principal.tenantId }) } }),
});

const _verified = HttpModule("Verified")({
  needs: [Env],
  router: verifiedRouter,
  imports: [
    Module("Verifying")({
      provides: [Provider(Verifier)({ value: () => undefined })],
      exports: [Verifier],
    }),
  ],
});

// 12. The same root with nothing supplying `Verifier` is refused: the
//     authenticator's need is real, not erased by riding in on the router.
// @ts-expect-error — UNDECLARED NEEDS: the authenticator's own `Verifier`
void HttpModule("Unverified")({ needs: [Env], router: verifiedRouter });

void _verified;

// A scheme granting no scopes returns the identity bare — unchanged from what
// applications write today, which is the point.
const plain = HttpAuthenticator<{ readonly userId: string }>()({
  sync: () => () => OkAsync({ userId: "u-1" }),
});

// A scheme with a scope vocabulary reports what the credential granted, through
// `granted()` — which is the only thing that mints the brand the middleware
// reads, so this is mandatory rather than advisory.
const scoped = HttpAuthenticator<{ readonly userId: string }, "orders:export">()({
  sync: () => () => OkAsync(granted({ userId: "u-1" }, ["orders:export"])),
});

// A grant of nothing is still a grant: the vocabulary types the array, so an
// empty one does not collapse `Scope` back to the bare arm.
HttpAuthenticator<{ readonly userId: string }, "orders:export">()({
  sync: () => () => OkAsync(granted({ userId: "u-1" }, [])),
});

// Negative: a scoped scheme may not return a bare identity.
HttpAuthenticator<{ readonly userId: string }, "orders:export">()({
  // @ts-expect-error -- a scoped scheme must report its granted scopes
  sync: () => () => OkAsync({ userId: "u-1" }),
});

// Negative: nor a hand-built record. The brand is unforgeable from outside this
// package, so `{ identity, scopes }` is not the scoped answer — which is what
// stops a bare identity carrying `scopes` from being mistaken for one.
HttpAuthenticator<{ readonly userId: string }, "orders:export">()({
  // @ts-expect-error -- the scoped answer comes from `granted()`
  sync: () => () => OkAsync({ identity: { userId: "u-1" }, scopes: ["orders:export"] }),
});

// Negative: a scope outside the declared vocabulary is refused.
HttpAuthenticator<{ readonly userId: string }, "orders:export">()({
  // @ts-expect-error -- "orders:delete" is not in this scheme's vocabulary
  sync: () => () => OkAsync(granted({ userId: "u-1" }, ["orders:delete"])),
});

expectTypeOf(plain.principal).toEqualTypeOf<{ readonly userId: string }>();
expectTypeOf(scoped.scope).toEqualTypeOf<"orders:export">();
