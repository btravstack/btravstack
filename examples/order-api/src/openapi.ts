import { contract } from "@btravstack/example-order-api-contract";
import { openApiDocument, type OpenApiDocument } from "@btravstack/http-server/openapi";
import type { AsyncResult } from "unthrown";

/**
 * The API's OpenAPI document.
 *
 * The contract already says WHICH schemes protect each route and which scopes
 * each must grant; what it deliberately does not say is what a scheme IS. That
 * half is here, beside `auth.ts`'s authenticators — the same split, one layer
 * out: `auth.ts` says what `user` resolves to for the server, this says what it
 * looks like to a client reading the document.
 *
 * Not served by the runtime. `@btravstack/http-server` mounts no documentation
 * route and ships no UI asset; an application that wants Swagger UI serves this
 * value from a route of its own, which keeps a UI bundle out of a transport
 * package.
 */
export const openApi = (): AsyncResult<OpenApiDocument, never> =>
  openApiDocument(contract, {
    base: {
      info: {
        title: "Order API",
        version: "1.0.0",
        description: "The clean-architecture example, served over HTTP.",
      },
    },
    securitySchemes: {
      user: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      service: { type: "apiKey", in: "header", name: "x-service-key" },
    },
  });
