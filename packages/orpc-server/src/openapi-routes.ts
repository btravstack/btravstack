import { Observers } from "@btravstack/core";
import { Provider } from "@btravstack/di";
import { HttpConfig, HttpHandler } from "@btravstack/http-server/internal";
import { OpenAPIHandler } from "@orpc/openapi/node";

import { OrpcRouterPort, pluginsOf, reportDefects, type OrpcOptions } from "./orpc.js";

/** Answerer-local policies; body limits and CSRF belong to the HTTP module. */
export type OpenApiRoutesOptions = Omit<OrpcOptions, "prefix" | "bodyLimit" | "csrf"> & {
  /** Where ordinary method-and-path requests are served. Default `/api`. */
  readonly prefix?: `/${string}`;
};

/** Serve a contract's OpenAPI routes through the same router and HTTP runtime as RPC. */
export const openApiRoutes = (options: OpenApiRoutesOptions = {}) => {
  const prefix = options.prefix ?? "/api";
  return Provider.member(HttpHandler)({
    inject: { router: OrpcRouterPort, config: HttpConfig, observers: Observers },
    sync: ({ router, config, observers }) => {
      const handler = new OpenAPIHandler(router, {
        // OpenAPI GET routes use HTTP's safe-method contract, not RPC's GET exception.
        plugins: [...pluginsOf(options, config, false)],
        clientInterceptors: reportDefects(observers),
      });
      return {
        prefix,
        handle: (request, response, _signal, host) =>
          handler.handle(request, response, { prefix, context: { request, host } }),
      };
    },
  });
};
