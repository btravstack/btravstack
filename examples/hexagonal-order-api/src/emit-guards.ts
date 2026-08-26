/**
 * NOT example code. Do not copy anything out of this file.
 *
 * A compile-time test living beside an example, because what it tests IS what an
 * example is: a downstream package that uses `@btravstack/di` and **emits its
 * own declarations**. Every shape below is one `tsconfig.emit.json` has to be
 * able to write into a `.d.ts` — which `tsc --noEmit` does not exercise, and
 * which was broken (`TS4020` on every consumer that exported a port).
 *
 * Three rules that are easy to destroy by tidying:
 *
 *  1. **An unused `@ts-expect-error` here is a failure, not noise.** The cheap
 *     fix for `TS4020` — exporting `ID`/`SERVICE`/`MANY` — makes emit work and
 *     destroys what the brands exist for: with the symbols in hand a consumer
 *     hand-writes a port instance and passes it off as a real one. The
 *     directives below assert the symbols are still out of reach.
 *
 *  2. **The gate compiles this file, it does not merely check it.** `TS4020` is
 *     raised by the declaration EMITTER, so `noEmit` must be off, and the
 *     emitted output is fed back through the compiler because a dangling
 *     reference in it is not an emit-time diagnostic. The re-check names
 *     `emit-guards.d.ts` explicitly, since nothing imports this file. Never add
 *     `--skipLibCheck`: the run then exits 0 on broken output.
 *
 *  3. **Both the plain port and the `Port.many` port are load bearing.** They
 *     fail through different brands — `ID`/`SERVICE` against `PortClass`, and
 *     additionally `MANY` against `ManyPortClass` — so a fix naming only one
 *     class type leaves the other broken. Measured: with just the instance
 *     types nameable, the plain port emitted and the set port still reported
 *     `private name 'MANY'`.
 */
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

// Each of these resolves only if the package starts exporting the symbol, at
// which point the forgery above becomes writable.
// @ts-expect-error `@btravstack/di` exports no `ID`
declare const idBrand: typeof import("@btravstack/di").ID;
// @ts-expect-error `@btravstack/di` exports no `SERVICE`
declare const serviceBrand: typeof import("@btravstack/di").SERVICE;
// @ts-expect-error `@btravstack/di` exports no `MANY`
declare const manyBrand: typeof import("@btravstack/di").MANY;
void idBrand;
void serviceBrand;
void manyBrand;

/* ── Exported ports: the shapes that tripped TS4020 ───────────────────────── */

/** A plain port. Fails on `ID`/`SERVICE` when `PortClass` is not nameable. */
export class Metrics extends Port("Metrics")<{
  readonly count: (name: string) => void;
}> {}

/** A set port. Fails additionally on `MANY` when `ManyPortClass` is not nameable. */
export class Subscribers extends Port.many("Subscribers")<{
  readonly topic: string;
  readonly handle: (order: Order) => void;
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

export const SubscriberProvider = Provider.member(Subscribers)({
  value: { topic: "orders", handle: () => {} },
});

export const ObservabilityModule = Module("Observability")({
  needs: [OrderRepository],
  provides: [
    MetricsProvider,
    SubscriberProvider,
    Provider(OrderCache)({ value: { peek: () => undefined } }),
    Provider(Auditor)(
      { orders: OrderRepository },
      {
        sync: ({ orders }) => ({ orders, record: () => Ok(undefined).toAsync() }),
      },
    ),
  ],
  exports: [Metrics, Subscribers, OrderCache, Auditor],
});

/** A `Module<…>` whose inferred type names port instances in its type arguments. */
export const AppModule = makeAppModule(InMemoryPersistenceModule);

/** `ServiceOf` on the class and on the instance, both emitted. */
export const subscribers: ServiceOf<typeof Subscribers> = [];
export const metrics: ServiceOf<Metrics> = { count: () => {} };
export declare const getOrder: ServiceOf<GetOrder>;

/** A union of port instance types — what a `Module`'s `Exports` channel is. */
export type Vocabulary = Metrics | Auditor | OrderCache;

/** A helper generic over `AnyPort`: its inferred return type names the port. */
export const identity = <P extends AnyPort>(port: P): P => port;

/** Factories whose *return* type is the class type itself, not an instance. */
export const definePort = <const Id extends string>(id: Id) => Port(id);
export const defineSetPort = <const Id extends string>(id: Id) => Port.many(id);
