export const VERSION = "0.1.0";

export { currentUnit } from "./ambient.js";
export type { UnitRecord } from "./ambient.js";
export { systemClock } from "./clock.js";
export type { Clock } from "./clock.js";
export type { DrainReport } from "./drain-report.js";
export { stderrSink } from "./events.js";
export type { EventSink, KernelEvent } from "./events.js";
export type { Phase } from "./phase.js";
export { RuntimeStartFailed } from "./runtime.js";
export type { RunUnit, Runtime, RuntimeHost, Serving } from "./runtime.js";
export { start } from "./start.js";
export type { ExitReport, RunningApp, StartOptions, TeardownError } from "./start.js";
export type { UnitMeta, UnitRegistry, UnitWork } from "./units.js";
