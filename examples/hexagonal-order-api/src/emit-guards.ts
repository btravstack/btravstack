/**
 * NOT example code. Do not copy anything out of this file.
 *
 * It is a compile-time test that happens to live beside an example, because
 * what it tests *is* what an example is: a downstream package that uses
 * `@btravstack/di` and **emits its own declarations**. Everything below is a
 * consumer-side shape that `tsconfig.emit.json` has to be able to write into a
 * `.d.ts` — the one thing `tsc --noEmit` on the example proper does not fully
 * exercise, and the thing that was broken.
 *
 * What went wrong when nothing checked this: `PortInstance`'s brand keys are
 * two module-private `unique symbol`s (`ID`/`SERVICE`), and `PortClass` was not
 * exported from the package index. With no name to reach for, the emitter
 * expanded a port class's
 * heritage expression down to those symbols, and **every consumer that exported
 * a port** — the pattern `packages/di/README.md` teaches on its first page —
 * failed with `TS4020: 'extends' clause of exported class 'X' has or is using
 * private name 'ID'`. The three example packages had been papering over it with
 * `declaration: false` in their own tsconfigs, which is why the repo was green
 * while no consumer could build. Those overrides are gone; this file is what
 * replaced them.
 *
 * Two rules that are easy to destroy by tidying:
 *
 *  1. **An unused `@ts-expect-error` here is a failure, not noise.** The fix
 *     for `TS4020` is to make more of the port machinery nameable, and the
 *     cheap version of that — exporting `ID`/`SERVICE` themselves —
 *     makes emit work while quietly destroying the thing the brands exist for:
 *     with the symbols in hand a consumer hand-writes `{ [ID]: "Pool",
 *     [SERVICE]: Shape }` and passes it off as a `Pool`. Measured: it
 *     type-checks. The directives below are the assertion that the symbols are
 *     still out of reach, so a directive going unused is the signal that
 *     someone widened the export surface too far.
 *
 *  2. **The gate compiles this file, it does not merely check it.** Emit-time
 *     diagnostics like `TS4020` are raised by the *declaration emitter*, so
 *     `noEmit` has to be off for the pass to mean anything, and the emitted
 *     output is then fed back through the compiler — a dangling reference in
 *     the output is not an emit-time diagnostic and would otherwise ship. The
 *     re-check names `emit-guards.d.ts` explicitly rather than `index.d.ts`
 *     alone: a file is checked only if it is named or reached by an import from
 *     something named, and **nothing imports this one**. Never add
 *     `--skipLibCheck` to that step; it turns off `.d.ts` checking entirely and
 *     the run exits 0 on broken output.
 * */
import { Module, Port, Provider, type AnyPort, type ServiceOf } from "@btravstack/di";
import { Ok, type AsyncResult } from "unthrown";

import {
  InMemoryPersistenceModule,
  OrderRepository,
  makeAppModule,
  type GetOrder,
  type Order,
} from "./index.js";

/* ── The brands stay out of reach ──────────────────────────────────────────
   Nominal identity is the whole point of the symbols; declaration emit must
   not have been bought with it. */

class Clock extends Port("Clock")<{ readonly now: () => string }> {}
class Stopwatch extends Port("Stopwatch")<{ readonly now: () => string }> {}

declare const structurallyIdentical: Stopwatch;
// @ts-expect-error two ports with identical service shapes but different ids do not unify
const unified: Clock = structurallyIdentical;
void unified;

declare const handWritten: {
  readonly id: "Clock";
  readonly service: { readonly now: () => string };
};
// @ts-expect-error a port instance cannot be forged: its brand keys are module-private symbols
const forged: Clock = handWritten;
void forged;

// @ts-expect-error nor by supplying the service shape on its own
const forgedFromService: Clock = { now: () => "" };
void forgedFromService;

// The brand keys themselves have no name a consumer can reach. Each of these
// resolves only if the package starts exporting the symbol, at which point the
// forgery above becomes writable — which is why the directives, not a comment,
// are what holds the export surface where it is.
// @ts-expect-error `@btravstack/di` exports no `ID`
declare const idBrand: typeof import("@btravstack/di").ID;
// @ts-expect-error `@btravstack/di` exports no `SERVICE`
declare const serviceBrand: typeof import("@btravstack/di").SERVICE;
void idBrand;
void serviceBrand;

/* ── Exported ports: the shapes that tripped TS4020 ───────────────────────── */

/** A plain port. Fails on `ID`/`SERVICE` when `PortClass` is not nameable. */
export class Metrics extends Port("Metrics")<{
  readonly count: (name: string) => void;
}> {}

/** A port whose service shape reaches through another port's `ServiceOf`. */
export class Auditor extends Port("Auditor")<{
  readonly orders: ServiceOf<OrderRepository>;
  readonly record: (order: Order) => AsyncResult<void, never>;
}> {}

/** A port re-declared over a shape imported from the example proper. */
export class OrderCache extends Port("OrderCache")<{
  readonly peek: (id: string) => Order | undefined;
}> {}

/* ── Everything downstream of a port, also emitted ────────────────────────── */

export const MetricsProvider = Provider(Metrics)({ value: { count: () => {} } });

export const ObservabilityModule = Module("Observability")({
  provides: [
    MetricsProvider,
    Provider(OrderCache)({ value: { peek: () => undefined } }),
    Provider(Auditor)(
      { orders: OrderRepository },
      {
        sync: ({ orders }) => ({ orders, record: () => Ok(undefined).toAsync() }),
      },
    ),
  ],
  exports: [Metrics, OrderCache, Auditor],
});

/** A `Module<…>` whose inferred type names port instances in its type arguments. */
export const AppModule = makeAppModule(InMemoryPersistenceModule);

/** `ServiceOf` on the class and on the instance, both emitted. */
export const metrics: ServiceOf<Metrics> = { count: () => {} };
export declare const metricsOfClass: ServiceOf<typeof Metrics>;
export declare const getOrder: ServiceOf<GetOrder>;

/** A union of port instance types — what a `Module`'s `Exports` channel is. */
export type Vocabulary = Metrics | Auditor | OrderCache;

/** A helper generic over `AnyPort`: its inferred return type names the port. */
export const identity = <P extends AnyPort>(port: P): P => port;

/** A factory whose *return* type is the class type itself, not an instance. */
export const definePort = <const Id extends string>(id: Id) => Port(id);
