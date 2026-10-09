import type { ConfigInvalid } from "@btravstack/config";
import { Observers } from "@btravstack/core";
import { Module } from "@btravstack/di";
import {
  HttpConfig,
  HttpHandler,
  HttpRuntime,
  httpServer,
  type AnyUnitModule,
  type HttpOptions,
  type HttpServerEnv,
  type UnitsNeedsOf,
} from "@btravstack/http-server/internal";

import { orpc, type OrpcOptions, type OrpcRouterPort } from "./orpc.js";

export type OrpcHttpOptions = Omit<HttpOptions, "cors" | "compression"> & OrpcOptions;

/** One oRPC answerer over the shared HTTP listener. */
export const http = <Units extends Readonly<Record<string, AnyUnitModule>> | undefined = undefined>(
  options: Omit<OrpcHttpOptions, "unit"> & { readonly unit?: Units } = {},
): Module<
  HttpRuntime | HttpConfig | HttpHandler | Observers,
  ConfigInvalid,
  HttpServerEnv | OrpcRouterPort | UnitsNeedsOf<Units>
> =>
  Module("Http")({
    imports: [httpServer(options)],
    provides: [orpc(options)],
    exports: [HttpRuntime, HttpConfig, HttpHandler, Observers],
  } as never) as unknown as Module<
    HttpRuntime | HttpConfig | HttpHandler | Observers,
    ConfigInvalid,
    HttpServerEnv | OrpcRouterPort | UnitsNeedsOf<Units>
  >;
