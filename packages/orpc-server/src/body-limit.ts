import { ORPCError, type DefaultInitialContext } from "@orpc/server";
import { RequestLimitHandlerPlugin } from "@orpc/server/plugins";
import type {
  StandardHandlerInterceptor,
  StandardHandlerPlugin,
  StandardHandlerRoutingInterceptor,
  StandardHandlerRoutingInterceptorOptions,
} from "@orpc/server/standard";

type Request = StandardHandlerRoutingInterceptorOptions<DefaultInitialContext>["request"];

/**
 * Set on the request a stream limit wraps, so the answer can tell. A symbol key
 * survives the spreads later interceptors make of the request.
 */
const OVER = Symbol("btravstack.streamBodyLimit");
type Over = { tripped: boolean };
type Limited = Request & { readonly [OVER]?: Over };

/** The errors a stream past its limit was failed with, so defect reporting can tell them. */
const refusals = new WeakSet<object>();

/** Whether `error`, or an error in its `cause` chain, is a stream this plugin refused. */
export const refusedStream = (error: unknown): boolean => {
  const seen = new Set<unknown>();
  for (let at = error; typeof at === "object" && at !== null && !seen.has(at);) {
    if (refusals.has(at)) return true;
    seen.add(at);
    at = (at as { readonly cause?: unknown }).cause;
  }
  return false;
};

/**
 * oRPC's `RequestLimitHandlerPlugin`, with the bound chosen by how the route
 * reads its body: a body read as a stream (`requestBodyHint: "octet-stream"`)
 * is held to `streamLimit` while it streams, and every other body to
 * `bufferedLimit`, by upstream's own interceptor. `0` is unbounded. The route
 * decides, never the client: a body whose kind is inferred from its headers is
 * a buffered one. Named and ordered as upstream's, so the limit still measures
 * a decompressed body.
 *
 * A stream past its limit errors its reader with `PAYLOAD_TOO_LARGE`, and the
 * request answers that `413` whatever the handler made of the error: a refusal
 * of the body is the transport's, like the one a declared `content-length`
 * gets before any byte is read. Nor is it a defect: `reportDefects` skips an
 * error whose `cause` chain holds the refusal, which is how `@unthrown/orpc`
 * carries it out of a handler that did not model the failure.
 */
export const bodyLimitPlugin = (
  bufferedLimit: number,
  streamLimit: number,
): StandardHandlerPlugin<DefaultInitialContext> => {
  const [limitBuffered] =
    bufferedLimit === 0
      ? []
      : (new RequestLimitHandlerPlugin({ maxBodySize: bufferedLimit }).init({})
          .routingInterceptors ?? []);
  const limited: StandardHandlerRoutingInterceptor<DefaultInitialContext> = (options) => {
    const original = options.request;
    const over: Over = { tripped: false };
    const withStreams = (request: Request): Request =>
      ({
        ...request,
        [OVER]: over,
        resolveBody: (hint) =>
          hint === "octet-stream"
            ? streamed(original, streamLimit, over)
            : request.resolveBody(hint),
      }) as Limited;
    if (limitBuffered === undefined)
      return options.next({ ...options, request: withStreams(original) });
    return limitBuffered({
      ...options,
      next: (inner = options) => options.next({ ...inner, request: withStreams(inner.request) }),
    });
  };
  const refused: StandardHandlerInterceptor<DefaultInitialContext> = async ({ next, request }) => {
    const answered = next();
    await answered.catch(() => undefined);
    if ((request as Limited)[OVER]?.tripped === true)
      // oxlint-disable-next-line unthrown/no-throw -- oRPC encodes what an interceptor throws as the answer
      throw new ORPCError("PAYLOAD_TOO_LARGE");
    return answered;
  };
  return {
    name: "~request-limit",
    after: ["~batch"],
    before: ["~request-compression"],
    init: (options) => ({
      ...options,
      routingInterceptors: [limited, ...(options.routingInterceptors ?? [])],
      interceptors: [refused, ...(options.interceptors ?? [])],
    }),
  };
};

const streamed = async (request: Request, limit: number, over: Over) => {
  if (limit === 0) return request.resolveBody("octet-stream");
  if (Number(request.headers["content-length"]) > limit)
    // oxlint-disable-next-line unthrown/no-throw -- oRPC's resolveBody refuses by rejecting, and answers the ORPCError's 413
    throw new ORPCError("PAYLOAD_TOO_LARGE");
  const body = await request.resolveBody("octet-stream");
  if (!(body instanceof ReadableStream)) return body;
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        seen += chunk.byteLength;
        if (seen <= limit) return controller.enqueue(chunk);
        over.tripped = true;
        const refusal = new ORPCError("PAYLOAD_TOO_LARGE");
        refusals.add(refusal);
        controller.error(refusal);
      },
    }),
  );
};
