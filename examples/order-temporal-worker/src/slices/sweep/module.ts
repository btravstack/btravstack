import { Module } from "@btravstack/di";

import { sweepStaleOrders } from "./activities.js";

/**
 * The sweep slice: the scheduled workflow's one activity, and nothing else.
 * It imports nothing and needs nothing from the root — the repository it
 * removes through is built per ATTEMPT, in `ActivityUnitModule`, over the
 * tenant the schedule's arguments name.
 */
export const SweepSlice = Module("SweepSlice")({
  provides: [sweepStaleOrders],
  exports: [sweepStaleOrders],
});
