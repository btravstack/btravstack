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
import { Module, Port, Provider } from "@btravstack/di";
import { HttpModule, HttpRuntime, http } from "@btravstack/http-server";
import { observability } from "@btravstack/observability";

import { OrderApi, orderRouter } from "./module.js";
import { CustomersSlice } from "./slices/customers/module.js";
import { OrdersSlice } from "./slices/orders/module.js";

const options = { signals: false, probes: false } as const;

// Positive: the composition root exports the runtime, so the marker collapses
// to `unknown` and this is an ordinary two-argument call.
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

// The `unit` needs-propagation gate: a bound `unit.anonymous` module's own
// unmet needs join `HttpModule`'s own Needs channel (an import's own unmet
// needs are not `HttpModule`'s OWN call to re-declare — di's `NeedsGate`
// TSDoc), so the gate that refuses them is `start`'s ordinary
// `UNSATISFIED DEPENDENCIES`, never a marker of the kernel's.
//
// A trivial dep/mark pair, deliberately unrelated to `RequestModule`: the
// only need either call below can leak is this module's own.
class HttpUnitDep extends Port("HttpUnitDep")<{ readonly value: number }> {}
class HttpUnitMark extends Port("HttpUnitMark")<{ readonly at: number }> {}
const HttpUnitModule = Module("HttpUnitModule")({
  needs: [HttpUnitDep],
  provides: [
    Provider(HttpUnitMark)({
      inject: { dep: HttpUnitDep },
      sync: ({ dep }) => ({ at: dep.value }),
    }),
  ],
  exports: [HttpUnitMark],
});

const _withUnitSatisfied = start(
  HttpModule("WithUnitSatisfied")({
    router: orderRouter,
    unit: { anonymous: HttpUnitModule },
    imports: [OrdersSlice, CustomersSlice, observability(), cache({ adapter: memoryCache() })],
    provides: [Provider(HttpUnitDep)({ inject: {}, value: { value: 1 } })],
    exports: [Logger],
  }),
  options,
);
void _withUnitSatisfied;

const _unloggedUnit = HttpModule("WithUnitUnmet")({
  router: orderRouter,
  unit: { anonymous: HttpUnitModule },
  imports: [OrdersSlice, CustomersSlice, observability(), cache({ adapter: memoryCache() })],
  exports: [Logger],
});
// @ts-expect-error — UNSATISFIED DEPENDENCIES: nothing provides `HttpUnitDep`, which `HttpUnitModule` needs
const _withUnitUnmet = start(_unloggedUnit, options);
void _withUnitUnmet;
