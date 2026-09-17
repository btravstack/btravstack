// What `prismaDatabase` promises at the type level: the port carries the
// application's OWN client type, the module needs `Env` and NOTHING else, and a
// client with no pool to close is refused. Each assertion is mutual
// (`A extends B` and `B extends A`), so a needs list that GAINS a port fails
// too — one-way assignability would let it widen silently, which is exactly how
// the observability ports would creep back in.
import { Env, type ConfigInvalid } from "@btravstack/config";
import type { Module, ServiceOf } from "@btravstack/di";

import { prismaDatabase, type PrismaBinding } from "./prisma.js";

type Expect<T extends true> = T;
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** A stand-in for the client an emitted contract types. */
type Client = {
  readonly raw: {
    readonly sql: (
      strings: TemplateStringsArray,
      ...values: readonly unknown[]
    ) => { readonly affectedCount: () => unknown };
  };
  readonly runtime: () => {
    readonly execute: (plan: unknown) => Promise<unknown>;
    readonly close: () => Promise<void>;
  };
  readonly orm: { readonly orders: { readonly Order: { readonly all: () => Promise<string[]> } } };
};
declare const client: (binding: PrismaBinding) => Client;

const database = prismaDatabase("OrderDatabase")({ client });

type NeedsOf<M> = M extends Module<infer _X, infer _E, infer N> ? N : never;
type ErrorOf<M> = M extends Module<infer _X, infer E, infer _N> ? E : never;

// 1. The port's service is the APPLICATION's client, not `PrismaLike`. This is
//    the whole reason the `client` arrow exists rather than a shipped type.
type _Service = Expect<Exactly<ServiceOf<InstanceType<typeof database.port>>, Client>>;

// 2. The port id carries the name it was minted from, so two databases in one
//    application are two ports rather than a duplicate-provider defect.
type _PortId = Expect<Exactly<typeof database.port.portId, "OrderDatabase">>;

// 3. `Env`, and NOTHING else. `Logger` went with the engine: Prisma 8 has no
//    engine to trace and ships no instrumentation package, so the one startup
//    fact that needed a logger — "tracing is off because the optional peer is
//    absent" — has nothing left to report. Observation is a set port this
//    module contributes its own no-op member to. The assertion is MUTUAL, so a
//    port creeping back in fails here.
type _Needs = Expect<Exactly<NeedsOf<typeof database>, Env>>;

// 4. The flag is gone, not deprecated: passing it is a compile error rather
//    than a silently ignored option.
// @ts-expect-error — `instrumented` no longer exists; observation is a set port.
void prismaDatabase("OrderDatabase")({ client, instrumented: false });

// 5. The error channel is the config's, unwrapped — the starter mints none of
//    its own, because opening cannot fail in the application's terms.
type _Error = Expect<Exactly<ErrorOf<typeof database>, ConfigInvalid>>;

// 6. A client with no pool to close is refused: `PrismaLike` is the one thing
//    the starter needs of it.
// @ts-expect-error — no `runtime()`, so the resourceful provider has nothing to release
void prismaDatabase("Bad")({ client: () => ({ orm: {} }) });
