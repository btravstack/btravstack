import { Observers } from "@btravstack/core";
import { Provider } from "@btravstack/di";
import { HttpConfig, HttpHandler } from "@btravstack/http-server/internal";
import { OpenAPIHandlerCodec } from "@orpc/openapi/standard";
import type { AnyProcedure, DefaultInitialContext } from "@orpc/server";
import { NodeHttpHandler } from "@orpc/server/node";
import { StandardHandler } from "@orpc/server/standard";

import { errorStatusesOf } from "./error-status.js";
import { OrpcRouterPort, pluginsOf, reportDefects, type OrpcOptions } from "./orpc.js";

class ContractOpenApiCodec extends OpenAPIHandlerCodec<DefaultInitialContext> {
  override async encodeError(
    error: Parameters<OpenAPIHandlerCodec<DefaultInitialContext>["encodeError"]>[0],
    procedure?: AnyProcedure,
  ) {
    const response = await super.encodeError(error);
    const status = procedure === undefined ? undefined : errorStatusesOf(procedure)[error.code];
    return error.defined && status !== undefined ? { ...response, status } : response;
  }
}

/** Answerer-local policies; body limits and CSRF belong to the HTTP module. */
export type OpenApiRoutesOptions = Omit<OrpcOptions, "prefix" | "bodyLimit" | "csrf"> & {
  /** Where ordinary method-and-path requests are served. Default `/api`. */
  readonly prefix?: `/${string}`;
};

/**
 * Serve a contract's OpenAPI routes through the same router and HTTP runtime as
 * RPC. Declared errors use the matched procedure's `.errors(...)` entry's
 * integer `status` in `400`–`599`, falling back to oRPC's mapping when absent.
 */
export const openApiRoutes = (options: OpenApiRoutesOptions = {}) => {
  const prefix = options.prefix ?? "/api";
  return Provider.member(HttpHandler)({
    inject: { router: OrpcRouterPort, config: HttpConfig, observers: Observers },
    sync: ({ router, config, observers }) => {
      const handlerOptions = {
        // OpenAPI GET routes use HTTP's safe-method contract, not RPC's GET exception.
        plugins: [...pluginsOf(options, config, false)],
        clientInterceptors: reportDefects(observers),
      };
      const handler = new NodeHttpHandler(
        new StandardHandler(new ContractOpenApiCodec(router), handlerOptions),
        handlerOptions,
      );
      return {
        prefix,
        handle: (request, response, _signal, host) =>
          handler.handle(request, response, { prefix, context: { request, host } }),
      };
    },
  });
};
