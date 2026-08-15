import type { IncomingMessage, ServerResponse } from "node:http";

import { Port } from "@btravstack/di";

/**
 * The HTTP surface as a service — the node listener the runtime hands every
 * request to. INTERNAL: `http()` provides it from the application's router
 * (`orpc`), and the runtime provider depends on it through di; there is one
 * way to answer HTTP here, oRPC, so nothing outside this package
 * provides or names it. The package's own transport specs do, which is why it
 * is exported from this file and not from `index.ts`.
 *
 * Everything the client receives must be written from inside the handler —
 * the unit stays open until the response completes, so there is no way to be
 * late. It returns `PromiseLike<unknown>` rather than `void`: the package
 * needs to know when the handler is finished so it can answer a request the
 * handler declined, and a `void`-returning handler writing asynchronously
 * would draw a premature `404` over a response still in flight. `unknown`
 * because oRPC's `handle` resolves `{ matched: boolean }`; the value is never
 * the unit's result.
 */
export class HttpHandler extends Port("HttpHandler")<
  (request: IncomingMessage, response: ServerResponse, signal: AbortSignal) => PromiseLike<unknown>
> {}
