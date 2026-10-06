import { withUnitRecord } from "@btravstack/core";
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
