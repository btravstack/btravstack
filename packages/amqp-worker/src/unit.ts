import { withUnitRecord } from "@btravstack/core";
import type { AnyPort } from "@btravstack/di";

type Handler = (helpers: never, message: never) => unknown;

/**
 * One handler entry — a function, or `[handler, options]` — with its piece's
 * declared record put on `context.unit`. Applied once per piece as di
 * constructs it, so a delivery costs one record and one context object.
 */
export const withUnit = (record: Readonly<Record<string, AnyPort>>, entry: unknown): unknown =>
  Array.isArray(entry)
    ? [withUnitRecord(record, entry[0] as Handler), entry[1]]
    : withUnitRecord(record, entry as Handler);
