import { Provider } from "@btravstack/di";
import { HttpHandler, send } from "@btravstack/http-server/internal";

import type { OpenApiDocument } from "./openapi.js";

/** Serve a supplied contract document publicly at one path, using GET or HEAD. */
export const openApiDocumentRoute = (options: {
  readonly path: `/${string}`;
  readonly document: OpenApiDocument;
}) =>
  Provider.member(HttpHandler)({
    inject: {},
    sync: () => {
      const body = JSON.stringify(options.document);
      return {
        prefix: options.path,
        handle: async (request, response) => {
          const pathname = URL.parse(request.url ?? "/", "http://x")?.pathname;
          if (pathname !== options.path) {
            send(response, 404);
          } else if (request.method !== "GET" && request.method !== "HEAD") {
            send(response, 405, { Allow: "GET, HEAD" });
          } else {
            response.writeHead(200, {
              "content-type": "application/json; charset=utf-8",
              "content-length": Buffer.byteLength(body),
            });
            response.end(request.method === "HEAD" ? undefined : body);
          }
        },
      };
    },
  });
