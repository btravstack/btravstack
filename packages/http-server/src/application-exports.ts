import { infrastructureExports, type InfrastructureExports } from "@btravstack/core";
import type { AnyModule, AnyProvider } from "@btravstack/di";

import { HttpHandler } from "./handler.js";
import { HttpRuntime } from "./http-runtime.js";

/** HTTP runtime ports, plus the kernel infrastructure the application's graph exposes. */
export type ApplicationExports<
  I extends readonly AnyModule[],
  P extends readonly AnyProvider[],
> = readonly [typeof HttpRuntime, typeof HttpHandler, ...InfrastructureExports<I, P>];

/** Infrastructure exports for an HTTP application root; ordinary module exports remain explicit. */
export const applicationExports = <
  const I extends readonly AnyModule[],
  const P extends readonly AnyProvider[],
>(
  imports: I,
  provides: P,
): ApplicationExports<I, P> => [
  HttpRuntime,
  HttpHandler,
  ...infrastructureExports(imports, provides),
];
