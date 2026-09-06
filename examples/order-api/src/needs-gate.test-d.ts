/**
 * The compile-time half of the transport layer: `start` resolves its runtime
 * from the `HttpRuntime` port the composition root exports, and
 * `http()`'s runtime provider depends on the router port through
 * di. Two gates, both at compile time and NOT the same mechanism: `start`'s
 * phantom marker, intersected onto `module`, turns a module that exports no
 * runtime into a `TS2345` whose last line is the arm's own sentence; and di's
 * `Module` typing turns a composition that imports the starter without
 * providing its router into an unmet need the same parameter refuses by
 * assignability, naming the port. Neither is di's `UNSATISFIED DEPENDENCIES`
 * gate. Type-checked by
 * this package's `test:types` script, never executed.
 */
import { cache, memoryCache } from "@btravstack/cache";
import { Env } from "@btravstack/config";
import { start, Logger } from "@btravstack/core";
import { Module } from "@btravstack/di";
import { HttpModule, HttpRuntime, http } from "@btravstack/http-server";
import { observability } from "@btravstack/observability";

import { OrderApi, orderRouter } from "./module.js";
import { RequestModule, ServiceModule, UserModule } from "./request-scope.js";
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

// The same graph without `http(...)`: nothing declared over `RuntimePort` is
// exported, so there is no runtime for `start` to resolve.
const RuntimelessApi = Module("RuntimelessApi")({
  needs: [Env],
  imports: [OrdersSlice, CustomersSlice, observability()],
  // The scheme authenticators are here so this arm fails on the marker ALONE:
  // the contract marks `orders`, so a graph carrying the router without them
  // has an unmet need too, and an arm that could fail either way pins neither
  // gate. `HttpModule` is what spreads them for a root that uses the sugar.
  provides: [orderRouter, ...orderRouter.authenticators],
  exports: [Logger],
});

// Negative: the marker becomes the `NO RUNTIME — …` sentence, which the module
// argument cannot satisfy, so the call fails to typecheck against it.
// @ts-expect-error — NO RUNTIME: the module exports no port declared over RuntimePort.
const _missingRuntime = start(RuntimelessApi, options);

// The starter imported without its router provided: `http()`'s runtime
// provider depends on the starter's own router port (the one
// `OrpcRouter(contract)({ inject: { name: Dep }, sync })` provides), so the composition owes it.
//
// It is the KERNEL's gate rather than di's declaration one, and the division
// is the point: the port is owed by `http()`, an IMPORT, and an import's needs
// travel published in its type rather than being re-declared here.
const RouterlessApi = Module("RouterlessApi")({
  imports: [OrdersSlice, CustomersSlice, observability(), http()],
  exports: [HttpRuntime, Logger],
});

// @ts-expect-error — the composition needs the router port and nothing provides it.
const _missingRouter = start(RouterlessApi, options);

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
  unit: { anonymous: RequestModule, user: UserModule, service: ServiceModule },
  imports: [OrdersSlice, CustomersSlice, observability(), cache({ adapter: memoryCache() })],
  exports: [Logger],
});

// @ts-expect-error — UNSATISFIED DEPENDENCIES: `OrderDatabase` | `Tracer`, which the bound kinds need
const _withUnitUnmet = start(_databaselessApi, options);
void _withUnitUnmet;
