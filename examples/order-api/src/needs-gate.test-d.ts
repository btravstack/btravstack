import { start } from "@btravstack/core";
/**
 * The compile-time half of the transport layer: `start` resolves its runtime
 * from the `HttpRuntime` port the composition root exports, and
 * `http()`'s runtime provider depends on the router port through
 * di. Two gates, both at compile time: `start`'s phantom rest-tuple gate turns
 * a module that exports no runtime into a call-site arity error, and di's own
 * `Module` typing turns a composition that imports the starter without
 * providing its router into an unmet need `start` refuses. Type-checked by
 * this package's `test:types` script, never executed.
 */
import { Module } from "@btravstack/di";
import { HttpAuthenticator, HttpModule, HttpRuntime, http } from "@btravstack/http";
import { Logger, observability } from "@btravstack/observability";
import { OkAsync } from "unthrown";

import { bearerAuthenticator } from "./authenticator.js";
import { OrderApi, orderRouter } from "./module.js";
import { RequestModule } from "./request-scope.js";
import { CustomersSlice } from "./slices/customers/module.js";
import { OrdersSlice } from "./slices/orders/module.js";

const options = { signals: false, probes: false } as const;

// Positive: the composition root exports the runtime, so the gate collapses to
// an empty tuple and this is an ordinary two-argument call.
const _wired = start(OrderApi, options);

// The same graph without `http(...)`: nothing declared over `RuntimePort` is
// exported, so there is no runtime for `start` to resolve.
const RuntimelessApi = Module("RuntimelessApi")({
  imports: [OrdersSlice, CustomersSlice, observability()],
  // The authenticator is here so this arm fails on arity ALONE: the contract
  // marks `orders`, so a graph carrying the router without one has an unmet
  // need too, and an arm that could fail either way pins neither gate.
  provides: [orderRouter, bearerAuthenticator],
  exports: [Logger],
});

// Negative: the gate becomes a required two-element tuple naming the missing
// runtime, and the call fails on arity.
// @ts-expect-error — NO RUNTIME: the module exports no port declared over RuntimePort.
const _missingRuntime = start(RuntimelessApi, options);

// The starter imported without its router provided: `http()`'s runtime
// provider depends on the starter's own router port (the one
// `HttpRouter(contract)(deps, arm)` provides), so the composition carries it
// as an unmet need — di's gate, not the kernel's, and it rejects the module
// at `start` rather than at arity.
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
  imports: [OrdersSlice, CustomersSlice, observability(), http()],
  provides: [orderRouter, bearerAuthenticator],
  exports: [HttpRuntime],
});

// @ts-expect-error — UNSATISFIED UNIT NEEDS: the module does not export Logger for RequestModule to read.
const _unitUnmet = start(UnloggedApi, { ...options, unit: RequestModule });

// The real root minus its authenticator. `contract.orders` is marked
// `authenticated`, so `HttpRouter` gave the router provider a dependency on
// the starter's `AuthenticatorPort` and nothing here discharges it. Same gate
// as `_missingRouter` above — di's, at `start`, not at `HttpModule(...)`,
// which is why the module below builds without complaint.
const UnauthenticatedApi = HttpModule("UnauthenticatedApi")({
  router: orderRouter,
  imports: [OrdersSlice, CustomersSlice, observability()],
  exports: [Logger],
});

// @ts-expect-error — the composition needs the authenticator port and nothing provides it.
const _missingAuthenticator = start(UnauthenticatedApi, options);

// The OTHER authenticator gate, and a different one: whether the authenticator
// resolves the contract's own principal. `AuthenticatorPort`'s service type is
// erased to `unknown`, so di sees the need discharged and would let this
// through — `HttpModuleOptions` compares the two itself, at the
// `HttpModule(...)` call, which is why this directive sits on the option and
// not on a `start` below it.
const wrongAuthenticator = HttpAuthenticator<{ readonly sub: string }>()([], {
  sync: () => () => OkAsync({ sub: "s-1" }),
});

const MismatchedApi = HttpModule("MismatchedApi")({
  router: orderRouter,
  // @ts-expect-error — the authenticator resolves `{ sub }`, not the contract's Principal.
  authenticator: wrongAuthenticator,
  imports: [OrdersSlice, CustomersSlice, observability()],
  exports: [Logger],
});

void _missingAuthenticator;
void MismatchedApi;
