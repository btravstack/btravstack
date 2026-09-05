import type { AnyPort, Context, Module, ServiceOf } from "@btravstack/di";

/**
 * Where `messageUnits` leaves the forked context for the piece wrappers to read.
 * A symbol rather than a name: the dispatcher merges it into the context every
 * handler sees, and a string key would appear on the record a handler written
 * against the `{ inject, sync }` arm destructures.
 */
export const UNIT_SCOPE: unique symbol = Symbol("@btravstack/amqp-worker/unit-scope");

/** What a bound unit module exports — the port instances a handler of that kind may read. */
export type UnitExportsOf<M> = M extends Module<infer X, never, unknown> ? X : never;

/** The declared `unit:` record, as the services a handler reads off `context.unit`. */
export type UnitRecordOf<U extends Readonly<Record<string, AnyPort>>> = {
  readonly [N in keyof U]: ServiceOf<InstanceType<U[N]>>;
};

/**
 * A piece injecting a port the bound `unit.message` module does not export.
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
 * Neither writable nor configurable — a handler reads what the fork holds, and
 * cannot reshape the record under the next delivery. With no `unit.message`
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

/**
 * One handler entry — a function, or `[handler, options]` — with its piece's
 * declared record put on `context.unit`. Applied once per piece as di
 * constructs it, so a delivery costs one record and one context object.
 */
export const withUnit = (record: Readonly<Record<string, AnyPort>>, entry: unknown): unknown => {
  const wrap =
    (handler: (helpers: never, message: never) => unknown) =>
    (helpers: Helpers, message: never): unknown => {
      const { [UNIT_SCOPE]: forked, ...rest } = helpers.context ?? {};
      return handler(
        {
          ...helpers,
          context: { ...rest, unit: unitRecordOf(forked as Context<never> | undefined, record) },
        } as never,
        message,
      );
    };
  return Array.isArray(entry)
    ? [wrap(entry[0] as (helpers: never, message: never) => unknown), entry[1]]
    : wrap(entry as (helpers: never, message: never) => unknown);
};
