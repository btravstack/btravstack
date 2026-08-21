import { Env } from "@btravstack/config";
import { start } from "@btravstack/core";
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
 * arity gate. Type-checked by
 * this package's `test:types` script, never executed.
 */
import { Module } from "@btravstack/di";
import {
  AuthenticatorPort,
  HttpAuthenticator,
  HttpModule,
  HttpRuntime,
  http,
} from "@btravstack/http";
import { Logger, observability } from "@btravstack/observability";
import { OkAsync } from "unthrown";

import { bearerAuthenticator } from "./authenticator.js";
import { OrderApi, orderRouter } from "./module.js";
import { RequestModule } from "./request-scope.js";
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
  // The authenticator is here so this arm fails on the marker ALONE: the contract
  // marks `orders`, so a graph carrying the router without one has an unmet
  // need too, and an arm that could fail either way pins neither gate.
  provides: [orderRouter, bearerAuthenticator],
  exports: [Logger],
});

// Negative: the marker becomes the `NO RUNTIME — …` sentence, which the module
// argument cannot satisfy, so the call fails to typecheck against it.
// @ts-expect-error — NO RUNTIME: the module exports no port declared over RuntimePort.
const _missingRuntime = start(RuntimelessApi, options);

// The starter imported without its router provided: `http()`'s runtime
// provider depends on the starter's own router port (the one
// `HttpRouter(contract)({ name: Dep }, arm)` provides), so the composition owes it.
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

// Positive: a `unit` module rides the same gate — `RequestModule` needs
// `Logger`, which the composition root exports, so the fork the kernel opens
// per request is proven satisfiable here, at the call site.
const _withUnit = start(OrderApi, { ...options, unit: RequestModule });

// Negative, the OTHER direction: the unit module's own needs must be covered
// by the module's exports (or `Scope`, which the fork opens). This composition
// has its runtime and router but does not export `Logger`, so only the unit
// half of the gate can be what rejects the call.
const UnloggedApi = Module("UnloggedApi")({
  needs: [Env],
  imports: [OrdersSlice, CustomersSlice, observability(), http()],
  provides: [orderRouter, bearerAuthenticator],
  exports: [HttpRuntime],
});

// @ts-expect-error — UNSATISFIED UNIT NEEDS: the module does not export Logger for RequestModule to read.
const _unitUnmet = start(UnloggedApi, { ...options, unit: RequestModule });

// The real root minus its authenticator. `contract.orders` is marked
// `authenticated`, so `HttpRouter` gave the router provider a dependency on
// the starter's `AuthenticatorPort` and nothing here discharges it. Same
// `AuthenticatorPort` IS exported, unlike the router port above, so this arm
// can declare it — and that is what keeps it a `start` negative: declaring
// moves the obligation to the composition root, it does not discharge it.
const UnauthenticatedApi = HttpModule("UnauthenticatedApi")({
  needs: [Env, AuthenticatorPort],
  router: orderRouter,
  imports: [OrdersSlice, CustomersSlice, observability()],
  exports: [Logger],
});

// @ts-expect-error — the composition needs the authenticator port and nothing provides it.
const _missingAuthenticator = start(UnauthenticatedApi, options);

// The OTHER authenticator gate, and a different one: whether the authenticator
// resolves what the handlers read. `AuthenticatorPort`'s service type is
// erased to `unknown`, so the needs channel sees it discharged and would let this
// through — `HttpModuleOptions` compares the ROUTER's identity against the
// authenticator's itself, at the `HttpModule(...)` call, which is why this
// directive sits on the option and not on a `start` below it. The contract
// declares no principal to compare against; `./auth.ts` is what declares one.
const wrongAuthenticator = HttpAuthenticator<{ readonly sub: string }>()({
  sync: () => () => OkAsync({ sub: "s-1" }),
});

const _mismatchedApi = HttpModule("MismatchedApi")({
  needs: [Env],
  router: orderRouter,
  // @ts-expect-error — the authenticator resolves `{ sub }`, not the router's Identity.
  authenticator: wrongAuthenticator,
  imports: [OrdersSlice, CustomersSlice, observability()],
  exports: [Logger],
});
