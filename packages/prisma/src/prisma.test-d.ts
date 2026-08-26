// What `prismaDatabase` promises at the type level: the port carries the
// application's OWN client type, the module's needs follow the `instrumented`
// flag exactly, and a client with no pool to close is refused. Each assertion
// is mutual (`A extends B` and `B extends A`), so a needs list that GAINS a
// port fails too — one-way assignability would let it widen silently.
import { Env, type ConfigInvalid } from "@btravstack/config";
import { Logger, Meter, Tracer } from "@btravstack/core";
import type { Module, ServiceOf } from "@btravstack/di";
import type { PrismaPg } from "@prisma/adapter-pg";

import { prismaDatabase } from "./prisma.js";

type Expect<T extends true> = T;
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** A stand-in for the client a schema generates, with an extension applied. */
type Client = {
  readonly $disconnect: () => Promise<void>;
  readonly $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  readonly order: { readonly tryFindMany: () => Promise<readonly string[]> };
};
declare const client: (adapter: PrismaPg) => Client;

const instrumented = prismaDatabase("OrderDatabase")({ client });
const plain = prismaDatabase("OrderDatabase")({ client, instrumented: false });

type NeedsOf<M> = M extends Module<infer _X, infer _E, infer N> ? N : never;
type ErrorOf<M> = M extends Module<infer _X, infer E, infer _N> ? E : never;

// 1. The port's service is the APPLICATION's client, not `PrismaLike`. This is
//    the whole reason the `client` arrow exists rather than a shipped type.
type _Service = Expect<Exactly<ServiceOf<InstanceType<typeof instrumented.port>>, Client>>;

// 2. The port id carries the name it was minted from, so two databases in one
//    application are two ports rather than a duplicate-provider defect.
type _PortId = Expect<Exactly<typeof instrumented.port.portId, "OrderDatabase">>;

// 3. Instrumented by default: the module needs the three telemetry ports, so a
//    root without `observability()` and `otel()` cannot compose it.
type _InstrumentedNeeds = Expect<
  Exactly<NeedsOf<typeof instrumented>, Env | Logger | Meter | Tracer>
>;

// 4. `instrumented: false` drops all three — opting out of telemetry, not out
//    of the database. `Env` stays, because the URL is still read.
type _PlainNeeds = Expect<Exactly<NeedsOf<typeof plain>, Env>>;

// 5. The error channel is the config's, unwrapped — the starter mints none of
//    its own, because opening cannot fail in the application's terms.
type _Error = Expect<Exactly<ErrorOf<typeof instrumented>, ConfigInvalid>>;

// 6. A client with no pool to close is refused: `PrismaLike` is the one thing
//    the starter needs of it.
// @ts-expect-error — no `$disconnect`, so the resourceful provider has nothing to release
void prismaDatabase("Bad")({ client: () => ({ order: {} }) });
