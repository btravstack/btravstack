import { withUnitRecord, type AnyUnitModule } from "@btravstack/core";
import type { AnyPort } from "@btravstack/di";

type Implementation = (helpers: never, input: never) => unknown;

/**
 * One entry of the activities record — a contract-global activity's own
 * implementation, or the record of them a workflow key carries — with its
 * piece's declared record put on `context.unit`. Applied once per piece as di
 * constructs it, so an attempt costs one record and one context object.
 */
export const withUnit = (record: Readonly<Record<string, AnyPort>>, entry: unknown): unknown =>
  typeof entry === "function"
    ? withUnitRecord(record, entry as Implementation)
    : Object.fromEntries(
        Object.entries(entry as Readonly<Record<string, Implementation>>).map(
          ([name, implementation]) => [name, withUnitRecord(record, implementation)],
        ),
      );

// A symbol, so no key of an activities record can collide with it.
const PIECE_UNIT: unique symbol = Symbol("@btravstack/temporal-worker/piece-unit");

export const withFork = (entry: unknown, fork: AnyUnitModule | undefined): unknown =>
  fork === undefined ? entry : Object.defineProperty(entry as object, PIECE_UNIT, { value: fork });

export const forkOf = (entry: unknown): AnyUnitModule | undefined =>
  (entry as { readonly [PIECE_UNIT]?: AnyUnitModule } | undefined)?.[PIECE_UNIT];

export const unitsOf = (
  activity: AnyUnitModule | undefined,
  activities: Readonly<Record<string, unknown>>,
): Readonly<Record<string, AnyUnitModule | undefined>> => {
  const units = new Map<string, AnyUnitModule | undefined>([["activity", activity]]);
  for (const fork of Object.values(activities).map(forkOf)) {
    if (fork === undefined || fork === activity) continue;
    const bound = units.get(fork.name);
    if (bound !== undefined && bound !== fork) {
      // oxlint-disable-next-line unthrown/no-throw -- a wiring bug found as the runtime is built, inside di's construction, which turns the throw into the boot's defect
      throw new Error(
        `[temporal-worker] two unit modules named "${fork.name}" — an override keyed by that name could not tell them apart; rename one`,
      );
    }
    units.set(fork.name, fork);
  }
  return Object.fromEntries(units);
};
