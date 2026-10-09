import { Provider, type AnyPort } from "@btravstack/di";

/**
 * A refused array: as long as the array the caller wrote, its head the caller's
 * own elements — which match — and its LAST element the marker paired with what
 * is wrong.
 *
 * TypeScript compares two equal-length tuples element by element, so the extra
 * diagnostic it reports lands on the trailing element and carries both the
 * sentence and the missing key. A fixed two-element tuple named the key only
 * when the array happened to be two elements long; every other arity was a
 * length mismatch, and the developer diffed the contract against the array by
 * hand.
 */
export type Refuse<
  T extends readonly unknown[],
  Marker extends string,
  Detail,
> = T extends readonly [...infer Head, unknown]
  ? readonly [...Head, readonly [Marker, Detail]]
  : readonly [readonly [Marker, Detail]];

/** How a starter puts a piece's declared `unit:` record on one of its entries. */
type EntryWrapper = (record: Readonly<Record<string, AnyPort>>, entry: unknown) => unknown;

/** A piece's `{ inject?, unit?, sync }` options, with the types each starter states erased. */
type PieceOptions = {
  readonly inject?: Readonly<Record<string, AnyPort>>;
  readonly unit?: Readonly<Record<string, AnyPort>>;
  readonly sync: (services: never) => unknown;
};

/**
 * The runtime half of a starter's piece factory — `AmqpHandler(contract, key)`,
 * `TemporalWorkflowActivities(contract, key)`: a provider on `port` whose
 * service is what `sync` answers, wrapped once by `withUnit` so it reads the
 * record the piece declared. The starter keeps the types; this keeps the body.
 */
export const mintPiece =
  (port: AnyPort, withUnit: EntryWrapper) =>
  (options: PieceOptions): unknown =>
    Provider(port as never)({
      inject: options.inject ?? {},
      sync: (services: never) => withUnit(options.unit ?? {}, options.sync(services)),
    } as never);

/**
 * The runtime half of a starter's composing provider — `AmqpHandlers(contract)`,
 * `TemporalActivities(contract)` — and its two arms. An array of pieces is
 * composed into one record keyed by each piece's port id less `prefix`, so the
 * services record IS the composed record; a `{ inject?, unit?, sync }` record
 * has `withUnit` applied to every entry `sync` answers.
 */
export const composeByPrefix = (
  port: AnyPort,
  prefix: string,
  withUnit: EntryWrapper,
): ((first: unknown) => unknown) => {
  const whole = mintPiece(port, (record, entries) =>
    Object.fromEntries(
      Object.entries(entries as Readonly<Record<string, unknown>>).map(([key, entry]) => [
        key,
        withUnit(record, entry),
      ]),
    ),
  );
  // An array is never a valid record call — its one argument is a record — so
  // `Array.isArray` alone identifies the composing arm.
  return (first) =>
    Array.isArray(first)
      ? Provider(port as never)({
          inject: Object.fromEntries(
            (first as readonly { readonly port: AnyPort }[]).map((piece) => [
              piece.port.portId.slice(prefix.length),
              piece.port,
            ]),
          ),
          sync: (services: unknown) => services,
        } as never)
      : whole(first as PieceOptions);
};
