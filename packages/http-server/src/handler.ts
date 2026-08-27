import type { IncomingMessage, ServerResponse } from "node:http";

import { Port } from "@btravstack/di";

/**
 * One protocol's answer to HTTP, mounted under `prefix`.
 *
 * Everything the client receives must be written from inside `handle` — the
 * unit stays open until the response completes, so there is no way to be late.
 * It returns `PromiseLike<unknown>` rather than `void`: the package needs to
 * know when the handler is finished so it can answer a request the handler
 * declined, and a `void`-returning handler writing asynchronously would draw a
 * premature `404` over a response still in flight. `unknown` because oRPC's
 * `handle` resolves `{ matched: boolean }`; the value is never the unit's
 * result, and the runtime reads "did you answer?" off the response rather than
 * off this — which is what lets an answerer be written against `node:http`
 * alone.
 */
export type HttpAnswerer = {
  /**
   * Where this answerer is mounted. It owns every path at or under it, and a
   * request is routed to the LONGEST prefix that matches — so `/` may host a
   * fragment answerer while `/rpc` hosts oRPC, and nesting is expected rather
   * than refused. Two answerers on one prefix is a startup failure.
   */
  readonly prefix: `/${string}`;
  readonly handle: (
    request: IncomingMessage,
    response: ServerResponse,
    signal: AbortSignal,
  ) => PromiseLike<unknown>;
};

/**
 * The HTTP surface as a SET port: every protocol served in this process
 * contributes one member, and the runtime routes each request to the one whose
 * prefix matches longest.
 *
 * A set port rather than the single function it used to be, because HTTP is one
 * transport carrying several protocols — oRPC here, GraphQL and htmx fragments
 * beside it — while a graph holds exactly one runtime. They cannot be three
 * runtimes; they are three answerers under one.
 *
 * The runtime reaches them through `Runtime.resolves` rather than through di,
 * because a member contributed by a SIBLING module is not visible from inside
 * this one: `start` gates that the composition root exports this port, and
 * `HttpModule` adds it to `exports` so an application never lists it.
 */
export class HttpHandler extends Port.many("HttpHandler")<HttpAnswerer> {}
