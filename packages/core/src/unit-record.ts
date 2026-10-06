import type { AnyPort, Context, Module, Scope, ServiceOf } from "@btravstack/di";
import type { AsyncResult } from "unthrown";

import { observed, type Operation, type Settle } from "./observation.js";
import type { RuntimeHost } from "./runtime.js";
import type { UnitMeta } from "./units.js";

/**
 * A module a runtime's `unit` option may bind, as the upper bound a starter
 * constrains its own `Unit` type parameter to. `Module`'s `_exports` channel is
 * contravariant, so `Exports = never` — never `unknown` — is what makes a REAL
 * module's own (necessarily narrower) export type assignable to this bound:
 * `(x: Concrete) => void` is assignable to `(x: never) => void`, not to
 * `(x: unknown) => void`.
 */
export type AnyUnitModule = Module<never, never, unknown>;

/**
 * The needs a bound unit module still owes, or `never` when none is bound.
 * `Scope` is excluded, since nothing can ever provide it — the same exemption
 * `NeedsGate` itself carries — and so is `Seeded`, the port the runtime's own
 * fork seed discharges.
 */
export type UnitNeedsOf<Unit, Seeded = never> =
  Unit extends Module<never, never, infer N> ? Exclude<N, Scope | Seeded> : never;

/** What a bound unit module exports — the port instances a piece of that kind may read. */
export type UnitExportsOf<M> = M extends Module<infer X, never, unknown> ? X : never;

/** A piece's declared `unit:` record, as the services it reads off `context.unit`. */
export type UnitRecordOf<U extends Readonly<Record<string, AnyPort>>> = {
  readonly [N in keyof U]: ServiceOf<InstanceType<U[N]>>;
};

/**
 * A piece injecting a port the bound unit module does not export. `unknown`
 * when every declared port is covered — including the empty case, so a worker
 * whose pieces declare no `unit:` is gated on nothing.
 */
export type UnitGate<Unit, Declared> = [
  Exclude<NonNullable<Declared>, UnitExportsOf<Unit>>,
] extends [never]
  ? unknown
  : {
      readonly "UNIT DOES NOT PROVIDE — a piece injects a port the bound unit module does not export": Exclude<
        NonNullable<Declared>,
        UnitExportsOf<Unit>
      >;
    };

/**
 * Where {@link dispatchUnit} leaves the forked context for {@link withUnitRecord}
 * to read. A symbol rather than a name: the library merges it into the context
 * every piece sees, and a string key would appear on the record a piece written
 * against the `{ inject, sync }` arm destructures.
 */
const UNIT_SCOPE: unique symbol = Symbol("@btravstack/core/unit-scope");

/**
 * The declared record, as a getter per name resolved on read out of the fork.
 * Neither writable nor configurable — a piece reads what the fork holds, and
 * cannot reshape the record under the next unit. With no unit module bound
 * there is nothing to resolve from, so the record is empty whatever was
 * declared.
 */
const unitRecordOf = (
  forked: Context<never> | undefined,
  record: Readonly<Record<string, AnyPort>>,
): Readonly<Record<string, unknown>> => {
  const unit: Record<string, unknown> = {};
  if (forked === undefined) return unit;
  for (const [name, port] of Object.entries(record))
    Object.defineProperty(unit, name, {
      enumerable: true,
      get: () => forked.get(port as never),
    });
  return unit;
};

/**
 * One `(helpers, input)` implementation with its piece's declared record put on
 * `helpers.context.unit`, resolved out of the fork {@link dispatchUnit} opened.
 * Applied once per piece as di constructs it, so a unit costs one record and
 * one context object. Each worker maps it over its own entry shape.
 */
export const withUnitRecord =
  (
    record: Readonly<Record<string, AnyPort>>,
    implementation: (helpers: never, input: never) => unknown,
  ) =>
  (
    helpers: { readonly context?: Readonly<Record<string | symbol, unknown>> },
    input: never,
  ): unknown => {
    const { [UNIT_SCOPE]: forked, ...rest } = helpers.context ?? {};
    return implementation(
      {
        ...helpers,
        context: { ...rest, unit: unitRecordOf(forked as Context<never> | undefined, record) },
      } as never,
      input,
    );
  };

/**
 * A worker middleware's body: observe `operation`, open one kernel unit, fork
 * `unit` — when one is bound — seeded with `seed`, and call `next` with the
 * forked context where {@link withUnitRecord} finds it. With no `unit` bound,
 * `next()` runs unchanged.
 *
 * Observed from whichever channel the unit settles on, a defect included: a
 * defect is a failed unit too, and an errors count that omitted it would be the
 * reassuring half.
 */
export const dispatchUnit = <T, E>(dispatch: {
  readonly host: RuntimeHost<never>;
  readonly observers: readonly ((operation: Operation) => Settle)[];
  readonly operation: Operation;
  readonly meta: UnitMeta;
  readonly unit: AnyUnitModule | undefined;
  readonly seed: readonly [AnyPort, unknown];
  readonly next: (overrides?: never) => AsyncResult<T, E>;
}): AsyncResult<T, E> =>
  observed(dispatch.observers, dispatch.operation, () =>
    dispatch.host.run(dispatch.meta, (scope) =>
      dispatch.unit === undefined
        ? dispatch.next()
        : // `as never`: `AnyUnitModule` erases a module's Needs to `unknown` —
          // the only bound a module with real needs can infer against — so
          // `fork`'s own `DependencyGate` never clears on its own. The needs
          // were checked once already, at the `Unit`-generic call site that
          // bound this module; this reasserts that proof rather than bypassing
          // it.
          scope
            .fork(dispatch.unit as never, [dispatch.seed] as never)
            .flatMap((forked) => dispatch.next({ context: { [UNIT_SCOPE]: forked } } as never)),
    ),
  );
