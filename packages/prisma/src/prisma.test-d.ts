// What `prismaDatabase` promises at the type level: the port carries the
// application's OWN client type, the module needs `Env` and NOTHING else, and a
// client with no pool to close is refused. Each assertion is mutual
// (`A extends B` and `B extends A`), so a needs list that GAINS a port fails
// too — one-way assignability would let it widen silently, which is exactly how
// the observability ports would creep back in.
import { Env, type ConfigInvalid } from "@btravstack/config";
import type { Logger } from "@btravstack/core";
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

const database = prismaDatabase("OrderDatabase")({ client });

type NeedsOf<M> = M extends Module<infer _X, infer _E, infer N> ? N : never;
type ErrorOf<M> = M extends Module<infer _X, infer E, infer _N> ? E : never;

// 1. The port's service is the APPLICATION's client, not `PrismaLike`. This is
//    the whole reason the `client` arrow exists rather than a shipped type.
type _Service = Expect<Exactly<ServiceOf<InstanceType<typeof database.port>>, Client>>;

// 2. The port id carries the name it was minted from, so two databases in one
//    application are two ports rather than a duplicate-provider defect.
type _PortId = Expect<Exactly<typeof database.port.portId, "OrderDatabase">>;

// 3. `Env` and `Logger`, and NOTHING else — where the flag charged `Logger`,
//    `Meter` and `Tracer`. Observation is a set port this module contributes
//    its own no-op member to, so the telemetry ports are gone; `Logger` stays
//    for exactly one line, the `debug` that says engine tracing is off because
//    the optional peer is absent — a STARTUP fact, not an operation an
//    observer could settle. The assertion is MUTUAL, so a port creeping back
//    in fails here.
type _Needs = Expect<Exactly<NeedsOf<typeof database>, Env | Logger>>;

// 4. The flag is gone, not deprecated: passing it is a compile error rather
//    than a silently ignored option.
// @ts-expect-error — `instrumented` no longer exists; observation is a set port.
void prismaDatabase("OrderDatabase")({ client, instrumented: false });

// 5. The error channel is the config's, unwrapped — the starter mints none of
//    its own, because opening cannot fail in the application's terms.
type _Error = Expect<Exactly<ErrorOf<typeof database>, ConfigInvalid>>;

// 6. A client with no pool to close is refused: `PrismaLike` is the one thing
//    the starter needs of it.
// @ts-expect-error — no `$disconnect`, so the resourceful provider has nothing to release
void prismaDatabase("Bad")({ client: () => ({ order: {} }) });
