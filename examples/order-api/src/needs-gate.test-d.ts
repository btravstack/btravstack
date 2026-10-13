/**
 * The compile-time half of the transport layer: `start` resolves its runtime
 * from the `HttpRuntime` port `HttpModule` exports, so a module that exports
 * no runtime is a `TS2345` whose last line is the `NO RUNTIME` sentence. A
 * root cannot leave the router out: `HttpModule` is the only way to compose
 * the starter, and it requires one. Type-checked by this package's
 * `typecheck` script, never executed.
 */
import { cache, memoryCache } from "@btravstack/cache";
import { Env } from "@btravstack/config";
import { start, Logger } from "@btravstack/core";
import { Module } from "@btravstack/di";
import { sessionCodec } from "@btravstack/http-server/session";
import { observability } from "@btravstack/observability";
import { HttpModule } from "@btravstack/orpc-server";

import { OrderApi, orderRouter } from "./module.js";
import { RequestModule, ServiceModule, SessionModule, UserModule } from "./request-scope.js";
import { CustomersSlice } from "./slices/customers/module.js";
import { OrdersSlice } from "./slices/orders/module.js";

const options = { signals: false, probes: false } as const;

// Positive: the composition root exports the runtime, so the marker collapses
// to `unknown` and this is an ordinary two-argument call.
//
// It is also where `HttpModule` hiding `Env` is pinned: `userAuth` is
// `jwtAuthenticator`, which binds three variables off the `Env` port, and
// `module.ts` still writes no `needs` line at all — the sugar carries it for
// every provider in the root, so a root composing a configured scheme owes
// nothing extra to say so.
const _wired = start(OrderApi, options);

// The same graph without `HttpModule`: nothing declared over `RuntimePort` is
// exported, so there is no runtime for `start` to resolve.
const RuntimelessApi = Module("RuntimelessApi")({
  needs: [Env],
  imports: [OrdersSlice, CustomersSlice, observability()],
  // The scheme authenticators are here so this arm fails on the marker ALONE:
  // the contract marks `orders`, so a graph carrying the router without them
  // has an unmet need too, and an arm that could fail either way pins neither
  // gate. `HttpModule` is what spreads them for a root that uses the sugar.
  provides: [orderRouter, ...orderRouter.authenticators, sessionCodec()],
  exports: [Logger],
});

// Negative: the marker becomes the `NO RUNTIME — …` sentence, which the module
// argument cannot satisfy, so the call fails to typecheck against it.
// @ts-expect-error — NO RUNTIME: the module exports no port declared over RuntimePort.
const _missingRuntime = start(RuntimelessApi, options);

// The `unit` needs-propagation gate: a bound kind's own unmet needs join
// `HttpModule`'s own Needs channel (an import's own unmet needs are not
// `HttpModule`'s OWN call to re-declare — di's `NeedsGate` TSDoc), so the gate
// that refuses them is `start`'s ordinary `UNSATISFIED DEPENDENCIES`, never a
// marker of the kernel's.
//
// `UserModule` reads `OrderDatabase` out of the application scope rather than
// importing the database module — one Prisma client per process, not one per
// request — so a root that binds it and composes no persistence owes the port.
// `OrderApi` above is the positive: it imports `OrderPersistenceModule`, which
// re-exports the database module, and exports the port the fork reads.
const _databaselessApi = HttpModule("DatabaselessApi")({
  router: orderRouter,
  unit: {
    anonymous: RequestModule,
    user: UserModule,
    service: ServiceModule,
    session: SessionModule,
  },
  provides: [sessionCodec()],
  imports: [OrdersSlice, CustomersSlice, observability(), cache({ adapter: memoryCache() })],
  exports: [Logger],
});

// @ts-expect-error — UNSATISFIED DEPENDENCIES: `OrderDatabase` | `Tracer`, which the bound kinds need
const _withUnitUnmet = start(_databaselessApi, options);
void _withUnitUnmet;
