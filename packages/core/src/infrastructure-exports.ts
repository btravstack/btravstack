import type { AnyModule, AnyPort, AnyProvider, Module, Provider } from "@btravstack/di";

import { HealthChecks } from "./health.js";
import { Logger } from "./observability.js";

type ModuleExports<M> = M extends Module<infer X, infer _E, infer _N> ? X : never;
type ProviderPorts<P> = P extends Provider<infer X, infer _E, infer _N> ? X : never;
type Available<I extends readonly AnyModule[], P extends readonly AnyProvider[]> =
  | ModuleExports<I[number]>
  | ProviderPorts<P[number]>;

type VisibleInfrastructure<P, Visible> = P extends AnyPort
  ? InstanceType<P> extends Visible
    ? P
    : never
  : never;

/** Kernel infrastructure publicly available through an application root. */
export type InfrastructureExports<
  I extends readonly AnyModule[],
  P extends readonly AnyProvider[],
> = readonly VisibleInfrastructure<typeof Logger | typeof HealthChecks, Available<I, P>>[];

const exportedPorts = (module: AnyModule): readonly AnyPort[] =>
  module.exports.flatMap((entry) => ("portId" in entry ? [entry] : exportedPorts(entry)));

/** Export visible Logger and HealthChecks ports without exposing private or business ports. */
export const infrastructureExports = <
  const I extends readonly AnyModule[],
  const P extends readonly AnyProvider[],
>(
  imports: I,
  provides: P,
): InfrastructureExports<I, P> => {
  const visible = new Set([
    ...imports.flatMap(exportedPorts).map((port) => port.portId),
    ...provides.map((provider) => provider.port.portId),
  ]);
  // The visibility filter implements the conditional type, which defers for generic tuples.
  return [Logger, HealthChecks].filter((port) =>
    visible.has(port.portId),
  ) as unknown as InfrastructureExports<I, P>;
};
