import type { AnyPort, Context, Module, ServiceOf } from "@btravstack/di";

/**
 * Where `activityUnits` leaves the forked context for the piece wrappers to
 * read. A symbol rather than a name: the middleware merges it into the context
 * every activity sees, and a string key would appear on the record an activity
 * written against the `{ inject, sync }` arm destructures.
 */
export const UNIT_SCOPE: unique symbol = Symbol("@btravstack/temporal-worker/unit-scope");

/** What a bound unit module exports — the port instances an activity of that kind may read. */
export type UnitExportsOf<M> = M extends Module<infer X, never, unknown> ? X : never;

/** The declared `unit:` record, as the services an activity reads off `context.unit`. */
export type UnitRecordOf<U extends Readonly<Record<string, AnyPort>>> = {
  readonly [N in keyof U]: ServiceOf<InstanceType<U[N]>>;
};

/**
 * A piece injecting a port the bound `unit.activity` module does not export.
 * `unknown` when every declared port is covered — including the empty case, so
 * a worker whose pieces declare no `unit:` is gated on nothing.
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
 * The declared record, as a getter per name resolved on read out of the fork.
 * Neither writable nor configurable — an activity reads what the fork holds, and
 * cannot reshape the record under the next attempt. With no `unit.activity`
 * bound there is nothing to resolve from, so the record is empty whatever was
 * declared.
 */
export const unitRecordOf = (
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

type Helpers = { readonly context?: Readonly<Record<string | symbol, unknown>> };

type Implementation = (helpers: never, input: never) => unknown;

/**
 * One entry of the activities record — a contract-global activity's own
 * implementation, or the record of them a workflow key carries — with its
 * piece's declared record put on `context.unit`. Applied once per piece as di
 * constructs it, so an attempt costs one record and one context object.
 */
export const withUnit = (record: Readonly<Record<string, AnyPort>>, entry: unknown): unknown => {
  const wrap =
    (implementation: Implementation) =>
    (helpers: Helpers, input: never): unknown => {
      const { [UNIT_SCOPE]: forked, ...rest } = helpers.context ?? {};
      return implementation(
        {
          ...helpers,
          context: { ...rest, unit: unitRecordOf(forked as Context<never> | undefined, record) },
        } as never,
        input,
      );
    };
  return typeof entry === "function"
    ? wrap(entry as Implementation)
    : Object.fromEntries(
        Object.entries(entry as Readonly<Record<string, Implementation>>).map(
          ([name, implementation]) => [name, wrap(implementation)],
        ),
      );
};
