import type { AnyPort, Context } from "@btravstack/di";
import { TaggedError, type AsyncResult } from "unthrown";

import type { DrainReport } from "./drain-report.js";
import type { UnitMeta, UnitWork } from "./units.js";

export class RuntimeStartFailed extends TaggedError("RuntimeStartFailed")<{
  readonly runtime: string;
  readonly cause: unknown;
}> {
  override message = `the ${this.runtime} runtime failed to start`;
}

// `Context<InstanceType<Needs>>`, not `Context<Needs>`: di parameterises
// `Context<in R>` by port *instance* types, while a runtime declares its needs
// as port *classes* (`AnyPort` is `abstract new () => AnyPortInstance`).
// `InstanceType<never>` is `never`, so a needs-free runtime is unaffected.
export type RunUnit<Needs extends AnyPort> = <T, E>(
  meta: UnitMeta,
  work: (ctx: Context<InstanceType<Needs>>, signal: AbortSignal) => ReturnType<UnitWork<T, E>>,
) => AsyncResult<T, E>;

export type RuntimeHost<Needs extends AnyPort> = {
  readonly ctx: Context<InstanceType<Needs>>;
  readonly run: RunUnit<Needs>;
};

export type Serving = {
  readonly drain: (signal: AbortSignal) => AsyncResult<DrainReport, never>;
  readonly stop: () => AsyncResult<void, never>;
};

export type Runtime<Needs extends AnyPort> = {
  readonly name: string;
  readonly needs: readonly Needs[];
  readonly start: (host: RuntimeHost<Needs>) => AsyncResult<Serving, RuntimeStartFailed>;
};
