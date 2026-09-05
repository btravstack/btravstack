// The six compile gates the composing router form exists to provide, the
// inheritance rule the contract's requirements follow, and the scheme ports a
// router declares from them. Each `@ts-expect-error` is an assertion: if one
// stops erroring, the gate is gone.
import { authenticated } from "@btravstack/contract";
import { Module, Port, Provider, type PortInstance } from "@btravstack/di";
import { oc, type as ocType } from "@orpc/contract";
import { OkAsync } from "unthrown";
import { expectTypeOf } from "vitest";

import { HttpAuthenticator, type AuthenticatorService } from "./auth.js";
import { defineHttp } from "./define-http.js";
import type { Implementation } from "./orpc.js";

type Expect<T extends true> = T;

/** A public API: no authenticators, so nothing types a principal anywhere. */
const publicApi = defineHttp();

const contract = { orders: { place: oc }, users: { find: oc } };

const ordersPiece = publicApi.OrpcController(
  contract,
  "orders",
)({ inject: {}, sync: () => ({ place: () => OkAsync("placed") }) });
const usersPiece = publicApi.OrpcController(
  contract,
  "users",
)({ inject: {}, sync: () => ({ find: () => OkAsync("found") }) });

// 1. Every contract key must be covered. The refusal is as long as the array
//    the caller wrote, so the diagnostic lands on its trailing element and
//    names both the "UNCOVERED CONTROLLERS — …" marker and the missing leaf,
//    at every arity — here, one element and `"users.find"`.
// @ts-expect-error — the `users` fragment is uncovered
void publicApi.OrpcRouter(contract)([ordersPiece]);

// 2. A key the contract does not declare is refused at the MINT — there is
//    nothing to type it by. (The retired keyed record's "UNDECLARED KEY" gate
//    moved here with the key.)
// @ts-expect-error — `billing` is not in the contract
void publicApi.OrpcController(contract, "billing");

// 3. A piece cannot sit under the wrong key — by construction, since its key
//    rides its port id. What the retired "controller under the wrong key" gate
//    refused is now an array that leaves a fragment uncovered — coverage being
//    over the leaves, the diagnostic names the missing PROCEDURE itself:
//    `users.find`.
// @ts-expect-error — two pieces for `orders` leave `users` uncovered
void publicApi.OrpcRouter(contract)([ordersPiece, ordersPiece]);

// 4. A procedure the fragment does not declare is rejected inside the piece.
void publicApi.OrpcController(
  contract,
  "orders",
)({
  inject: {},
  // @ts-expect-error — the fragment declares `place`, not `plce`
  sync: () => ({ plce: () => OkAsync("placed") }),
});

// 5. The do-not-break property: a slice lifts out of the composed router with
//    its PIECE UNCHANGED — the lifted root declares the very provider the
//    modulith composed and hands back what it built. Naming the piece is
//    deliberate: a fresh `sync` over the fragment would pin only that a
//    fragment is a valid contract, which says nothing about the piece
//    surviving the lift.
void publicApi.OrpcRouter(contract.orders)({
  inject: { implementation: ordersPiece.port },
  sync: ({ implementation }) => implementation,
});

// The correct composition and the WHOLE-ROUTER form, over the same contract,
// both still compile. An array is never a record, so `Array.isArray` alone
// tells the two apart (orpc.ts) — the sync-key ambiguity the retired keyed
// record needed a discriminator for is gone with it.
const composed = publicApi.OrpcRouter(contract)([ordersPiece, usersPiece]);
void publicApi.OrpcRouter(contract)({
  inject: {},
  sync: () => ({
    orders: { place: () => OkAsync("placed") },
    users: { find: () => OkAsync("f") },
  }),
});

// The composed provider must DECLARE its pieces as needs — if the composing
// overload (orpc.ts) ever stops carrying `InstanceType<T[number]["port"]>`,
// this collapses to `never` and di stops ordering the pieces before the
// router, silently.
type NeedsOf<T> = T extends Provider<infer _P, infer _E, infer N> ? N : never;
type _ComposedNeedsAreDeclared = Expect<[NeedsOf<typeof composed>] extends [never] ? false : true>;

// All five again, against a contract whose `orders` fragment is MARKED. The
// marker is a phantom key on the fragment, so every gate above has to survive
// it — the fifth especially: a marked slice must still lift out of the composed
// router with its piece unchanged. The contract names no principal, so the
// pieces here come from `defineHttp`, which is what types one.
const api = defineHttp({
  authenticators: {
    user: HttpAuthenticator<{ readonly userId: string }>()({
      inject: {},
      sync: () => () => OkAsync({ userId: "u-1" }),
    }),
    service: HttpAuthenticator<{ readonly appId: string }>()({
      inject: {},
      sync: () => () => OkAsync({ appId: "a-1" }),
    }),
  },
});

const markedContract = {
  orders: authenticated({ user: [] })(contract.orders),
  users: contract.users,
};

const markedOrders = api.OrpcController(
  markedContract,
  "orders",
)({ inject: {}, sync: () => ({ place: (opts) => OkAsync(opts.context.principal.userId) }) });
const markedUsers = api.OrpcController(
  markedContract,
  "users",
)({ inject: {}, sync: () => ({ find: () => OkAsync("found") }) });

// 1. Every contract key must be covered.
// @ts-expect-error — the `users` fragment is uncovered
void api.OrpcRouter(markedContract)([markedOrders]);

// 2. A key the contract does not declare is refused at the mint.
// @ts-expect-error — `billing` is not in the contract
void api.OrpcController(markedContract, "billing");

// 3. The wrong-key gate, by construction, for a marked fragment — same as
//    above, this diagnostic names `users.find`, not the fragment.
// @ts-expect-error — two pieces for `orders` leave `users` uncovered
void api.OrpcRouter(markedContract)([markedOrders, markedOrders]);

// 4. A procedure the fragment does not declare is rejected inside the piece.
void api.OrpcController(
  markedContract,
  "orders",
)({
  inject: {},
  // @ts-expect-error — the fragment declares `place`, not `plce`
  sync: () => ({ plce: () => OkAsync("placed") }),
});

// 5. The do-not-break lift, for a marked fragment.
void api.OrpcRouter(markedContract.orders)({
  inject: { implementation: markedOrders.port },
  sync: ({ implementation }) => implementation,
});

// The correct composition still compiles — `markedUsers` is a piece over an
// unmarked fragment inside a contract that marks another, which is the
// accepted direction: a handler that reads no principal is contravariantly
// fine. The other direction is what has to be refused: a piece whose handler
// READS a principal cannot be composed under the unmarked contract, where
// nothing would inject one.
const markedComposed = api.OrpcRouter(markedContract)([markedOrders, markedUsers]);
// @ts-expect-error — `markedOrders` needs a principal the unmarked contract declares nowhere
void api.OrpcRouter(contract)([markedOrders, markedUsers]);

// The inheritance half: a record's requirements are the default for every
// procedure beneath it, and a procedure's own REPLACE that default rather than
// adding to it.
type TwoSchemes = {
  readonly user: { readonly userId: string };
  readonly service: { readonly appId: string };
};

const grouped = authenticated({ user: [] })({
  place: oc.input(ocType<{ readonly id: string }>()).output(ocType<{ readonly id: string }>()),
  export: authenticated(
    { user: [] },
    { service: [] },
  )(oc.output(ocType<{ readonly csv: string }>())),
});

// A procedure under a marked record inherits that record's requirement.
type PlaceContext = Parameters<Implementation<typeof grouped, TwoSchemes>["place"]>[0]["context"];
expectTypeOf<PlaceContext["principal"]>().toEqualTypeOf<{ readonly userId: string }>();

// A procedure with its own mark replaces the default rather than adding to it.
type ExportContext = Parameters<Implementation<typeof grouped, TwoSchemes>["export"]>[0]["context"];
expectTypeOf<ExportContext["principal"]>().toEqualTypeOf<
  | { readonly scheme: "user"; readonly identity: { readonly userId: string } }
  | { readonly scheme: "service"; readonly identity: { readonly appId: string } }
>();

// The router depends on one port per scheme the contract names — so a missing
// authenticator is di's own unmet-need error naming the port, not a gate this
// package writes.
const twoSchemeRouter = api.OrpcRouter(grouped)({
  inject: {},
  sync: () => ({ place: () => OkAsync({ id: "o-1" }), export: () => OkAsync({ csv: "" }) }),
});

type SchemePort<S extends string> = S extends string
  ? PortInstance<`HttpAuthenticator:${S}`, AuthenticatorService<unknown>>
  : never;

// BOTH directions. A one-way check passes on a collapsed `never`, which is how
// a broken scheme walk would slip through — the same hole that hid a broken
// `SchemesOf` in `principal.test-d.ts`.
type _TwoSchemeNeeds = Expect<
  [Extract<NeedsOf<typeof twoSchemeRouter>, SchemePort<string>>] extends [
    SchemePort<"user" | "service">,
  ]
    ? [SchemePort<"user" | "service">] extends [NeedsOf<typeof twoSchemeRouter>]
      ? true
      : false
    : false
>;

// One mark, one scheme, one port — never the whole registry.
type _OneSchemeNeeds = Expect<
  [Extract<NeedsOf<typeof markedComposed>, SchemePort<string>>] extends [SchemePort<"user">]
    ? [SchemePort<"user">] extends [NeedsOf<typeof markedComposed>]
      ? true
      : false
    : false
>;

// An all-public contract declares none at all.
type _NoSchemeNeeds = Expect<
  [Extract<NeedsOf<typeof composed>, SchemePort<string>>] extends [never] ? true : false
>;

// ── What a contract's DEPTH means for slicing ──────────────────────────────
// A worker's contract is flat — a consumer name, a workflow name — so a piece
// per key partitions its whole surface. An HTTP contract is a TREE, so these
// arms pin where a piece may sit, the one degree of freedom the three starters
// do not share.

// A FLAT contract slices: its top-level keys are procedures rather than
// fragments, so a piece owns one procedure and the coverage gate still fires.
const flat = { place: oc, find: oc };
const flatPlace = publicApi.OrpcController(
  flat,
  "place",
)({ inject: {}, sync: () => () => OkAsync("placed") });
const flatFind = publicApi.OrpcController(
  flat,
  "find",
)({ inject: {}, sync: () => () => OkAsync("found") });
void publicApi.OrpcRouter(flat)([flatPlace, flatFind]);
// @ts-expect-error — `find` is uncovered, exactly as for a contract of fragments
void publicApi.OrpcRouter(flat)([flatPlace]);

// A DEEP contract slices at ANY depth: a piece may own any node of the tree,
// named by a dotted path, and the coverage gate is over the LEAVES — an array
// composes when its paths partition the procedures, at any mix of depths.
const deep = { v1: { orders: { place: oc, find: oc }, customers: { find: oc } }, health: oc };
const v1Orders = publicApi.OrpcController(
  deep,
  "v1.orders",
)({ inject: {}, sync: () => ({ place: () => OkAsync("placed"), find: () => OkAsync("found") }) });
const v1Customers = publicApi.OrpcController(
  deep,
  "v1.customers",
)({ inject: {}, sync: () => ({ find: () => OkAsync("found") }) });
const health = publicApi.OrpcController(
  deep,
  "health",
)({ inject: {}, sync: () => () => OkAsync("ok") });
const v1 = publicApi.OrpcController(
  deep,
  "v1",
)({
  inject: {},
  sync: () => ({
    orders: { place: () => OkAsync("placed"), find: () => OkAsync("found") },
    customers: { find: () => OkAsync("found") },
  }),
});

// Pieces that PARTITION the leaves compose, at any mix of depths.
void publicApi.OrpcRouter(deep)([v1Orders, v1Customers, health]);
void publicApi.OrpcRouter(deep)([v1, health]);

// Coverage is over the LEAVES, so what `Uncovered` computes is procedure paths.
// @ts-expect-error — the `health` procedure is uncovered
void publicApi.OrpcRouter(deep)([v1]);

// Two elements match the marker tuple's length, so this diagnostic names the
// missing PROCEDURE itself: `v1.customers.find`.
// @ts-expect-error — `v1.customers.find` is uncovered
void publicApi.OrpcRouter(deep)([v1Orders, health]);

// @ts-expect-error — `v1.orders` sits inside `v1`: two pieces implementing one procedure
void publicApi.OrpcRouter(deep)([v1, v1Orders, v1Customers, health]);

// @ts-expect-error — a path the contract does not declare
void publicApi.OrpcController(deep, "v1.billing");

// The port id carries the whole path.
type _PathPortId = Expect<
  typeof v1Orders.port.portId extends "OrpcController:v1.orders" ? true : false
>;

// The requirements fold down a dotted path: a mark on `v1` reaches a piece
// minted at `v1.orders`, exactly as `routerOf`'s `inherited` walk pushes it at
// runtime — a handler there reads the principal the ancestor's mark typed.
const markedDeep = { v1: authenticated({ user: [] })(deep.v1), health: oc };
void api.OrpcController(
  markedDeep,
  "v1.orders",
)({
  inject: {},
  sync: () => ({
    place: (opts) => OkAsync(opts.context.principal.userId),
    find: () => OkAsync("found"),
  }),
});

// A TOP-LEVEL contract key carrying a literal dot is UNSLICEABLE. `nest` splits
// a piece's path on `.`, so it cannot tell a path SEPARATOR from a dot inside
// one key: `{ "a.b": impl }` would rebuild as `{ a: { b: impl } }`, which
// coverage accepts and `routerOf`'s stray-key drop then discards — a 404 on a
// green compile. Both halves are refused here instead.
const dotted = { "a.b": oc, plain: oc };

// @ts-expect-error — `a.b` carries a literal dot: no piece path can name it
void publicApi.OrpcController(dotted, "a.b");

// …and the refusal SAYS WHY. Dropping the key from `ControllerKeyOf` alone
// leaves `not assignable to parameter of type '"plain"'`, which reads as a
// typo hint and sends a reader hunting for the wrong thing; the gate rides the
// `key` parameter so the sentence is in the diagnostic.
type _MintSaysWhy = Expect<
  Parameters<typeof publicApi.OrpcController<typeof dotted, "a.b">>[1] extends {
    readonly "UNSLICEABLE CONTRACT KEY — this path names a key containing a literal dot, which a piece path cannot encode; serve this contract with the { inject, sync } form instead": "a.b";
  }
    ? true
    : false
>;

const plainPiece = publicApi.OrpcController(
  dotted,
  "plain",
)({ inject: {}, sync: () => () => OkAsync("ok") });

// @ts-expect-error — the contract carries an unsliceable key
void publicApi.OrpcRouter(dotted)([plainPiece]);

// …and the diagnostic says UNSLICEABLE, not UNCOVERED: `a.b` is not a leaf some
// piece forgot, it is a leaf no piece can name. Reading the last overload's
// parameter is what tells the two markers apart, which `@ts-expect-error` alone
// cannot do.
const dottedRouter = publicApi.OrpcRouter(dotted);
type _Unsliceable = Expect<
  Parameters<typeof dottedRouter>[0] extends readonly [
    readonly [`UNSLICEABLE CONTRACT KEY${string}`, ...unknown[]],
  ]
    ? true
    : false
>;

// The escape hatch the marker points at: the `{ inject, sync }` form splits nothing,
// so it serves such a contract correctly and stays open.
void publicApi.OrpcRouter(dotted)({
  inject: {},
  sync: () => ({ "a.b": () => OkAsync("ok"), plain: () => OkAsync("ok") }),
});

// BELOW the top level the same key costs nothing, and the gate must not
// over-reach onto it. `nest` splits only a piece's PATH, never the
// implementation keys underneath — so a piece at the dotted key's PARENT hands
// `{ "a.b": fn }` to `routerOf` whole, and that walk has never split anything.
const dottedDeep = { v1: { "a.b": oc }, health: oc };

// @ts-expect-error — `v1.a.b` still cannot say which dot is the separator
void publicApi.OrpcController(dottedDeep, "v1.a.b");

// The parent IS nameable, and composing over it is exactly how such a contract
// is served by the array form.
const v1Dotted = publicApi.OrpcController(
  dottedDeep,
  "v1",
)({ inject: {}, sync: () => ({ "a.b": () => OkAsync("ok") }) });
const healthDotted = publicApi.OrpcController(
  dottedDeep,
  "health",
)({ inject: {}, sync: () => () => OkAsync("ok") });
void publicApi.OrpcRouter(dottedDeep)([v1Dotted, healthDotted]);

// ── `context.unit`: the record is declared once, and typed per leaf ─────────
// The kind a leaf's own requirements select decides which of the declared names
// are properties at all. A scheme that binds no module falls back to
// `anonymous`, so a leaf accepting two schemes sees what BOTH forked modules
// export — which is the intersection the runtime can actually satisfy.

class ControllerSpan extends Port("ControllerSpan")<{ readonly finish: () => void }> {}
class ControllerTenant extends Port("ControllerTenant")<string> {}

const AnonymousUnit = Module("ControllerAnonymousUnit")({
  provides: [Provider(ControllerSpan)({ inject: {}, sync: () => ({ finish: () => undefined }) })],
  exports: [ControllerSpan],
});

const UserUnit = Module("ControllerUserUnit")({
  needs: [api.principals.user],
  imports: [AnonymousUnit],
  provides: [
    Provider(ControllerTenant)({
      inject: { principal: api.principals.user },
      sync: ({ principal }) => principal.userId,
    }),
  ],
  exports: [ControllerTenant, AnonymousUnit],
});

// `service` is a declared scheme that binds NO module, so its leaves fall back
// to `anonymous` — the runtime rule, restated in the types.
const kinded = api.units<{ anonymous: typeof AnonymousUnit; user: typeof UserUnit }>();

const kindedContract = {
  customers: { find: oc },
  orders: authenticated({ user: [] })({
    find: oc,
    export: authenticated({ user: [] }, { service: [] })(oc),
  }),
};

// An UNMARKED leaf opens `anonymous`, which exports the span and not the tenant.
void kinded.OrpcController(
  kindedContract,
  "customers",
)({
  inject: {},
  unit: { span: ControllerSpan, tenant: ControllerTenant },
  sync: () => ({
    find: ({ context }) => {
      context.unit.span.finish();
      // @ts-expect-error — `tenant` is absent: the anonymous kind's module does not export it
      void context.unit.tenant;
      return OkAsync("found");
    },
  }),
});

// A `user`-marked leaf opens the module that kind bound, and sees both.
void kinded.OrpcController(
  kindedContract,
  "orders",
)({
  inject: {},
  unit: { span: ControllerSpan, tenant: ControllerTenant },
  sync: () => ({
    find: ({ context }) => {
      const tenant: string = context.unit.tenant;
      context.unit.span.finish();
      return OkAsync(tenant);
    },
    export: ({ context }) => {
      context.unit.span.finish();
      // @ts-expect-error — `tenant`: the `service` kind falls back to anonymous, which does not export it
      void context.unit.tenant;
      return OkAsync("csv");
    },
  }),
});

// Without `units<…>()` no kind binds a module, so every name is filtered out
// and `context.unit` is empty on every leaf — which is what keeps a piece
// declaring no `unit:` compiling exactly as it always did.
void api.OrpcController(
  kindedContract,
  "orders",
)({
  inject: {},
  unit: { tenant: ControllerTenant },
  sync: () => ({
    find: ({ context }) => {
      // @ts-expect-error — no kinds bound: `tenant` is absent
      void context.unit.tenant;
      return OkAsync("found");
    },
    export: () => OkAsync("csv"),
  }),
});

// The record rides the whole-router arm too, one record for every leaf.
void kinded.OrpcRouter(kindedContract)({
  inject: {},
  unit: { span: ControllerSpan, tenant: ControllerTenant },
  sync: () => ({
    customers: {
      find: ({ context }) => {
        context.unit.span.finish();
        // @ts-expect-error — an unmarked leaf under the router arm sees anonymous's exports alone
        void context.unit.tenant;
        return OkAsync("found");
      },
    },
    orders: {
      find: ({ context }) => OkAsync(context.unit.tenant),
      export: () => OkAsync("csv"),
    },
  }),
});

// A piece declaring no `unit:` at all still carries a record — the empty one —
// so the array arm reads the same field off every element.
const kindedCustomers = kinded.OrpcController(
  kindedContract,
  "customers",
)({ inject: {}, sync: () => ({ find: () => OkAsync("found") }) });
type _EmptyUnitRecord = Expect<keyof typeof kindedCustomers.unit extends never ? true : false>;
