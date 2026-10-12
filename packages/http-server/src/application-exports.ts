import { HealthChecks, Logger } from "@btravstack/core";
import type { AnyModule, AnyPort, AnyProvider, Module, Provider } from "@btravstack/di";

import { HttpHandler } from "./handler.js";
import { HttpRuntime } from "./http-runtime.js";

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

/** HTTP runtime ports, plus the kernel infrastructure the application's graph exposes. */
export type ApplicationExports<
  I extends readonly AnyModule[],
  P extends readonly AnyProvider[],
> = readonly (
  | typeof HttpRuntime
  | typeof HttpHandler
  | VisibleInfrastructure<typeof Logger | typeof HealthChecks, Available<I, P>>
)[];

const exportedPorts = (module: AnyModule): readonly AnyPort[] =>
  module.exports.flatMap((entry) => ("portId" in entry ? [entry] : exportedPorts(entry)));

/** Infrastructure exports for an HTTP application root; ordinary module exports remain explicit. */
export const applicationExports = <
  const I extends readonly AnyModule[],
  const P extends readonly AnyProvider[],
>(
  imports: I,
  provides: P,
): ApplicationExports<I, P> => {
  const visible = new Set([
    ...imports.flatMap(exportedPorts).map((port) => port.portId),
    ...provides.map((provider) => provider.port.portId),
  ]);
  return [
    HttpRuntime,
    HttpHandler,
    ...[Logger, HealthChecks].filter((port) => visible.has(port.portId)),
  ] as ApplicationExports<I, P>;
};
