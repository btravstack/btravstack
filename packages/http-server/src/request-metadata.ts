import type { IncomingMessage } from "node:http";

import { Port, type ServiceOf } from "@btravstack/di";

/**
 * Non-authentication metadata pinned to one HTTP request unit. Headers are an
 * immutable snapshot; the signal is the runtime's cancellation signal. Values
 * are untrusted input: decoding and authorization remain application policy.
 */
export class HttpRequestMetadata extends Port("HttpRequestMetadata")<{
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly signal: AbortSignal;
}> {}

export const requestMetadataOf = (
  incoming: IncomingMessage,
  signal: AbortSignal,
): ServiceOf<HttpRequestMetadata> =>
  Object.freeze({
    headers: Object.freeze(
      Object.fromEntries(
        Object.entries(incoming.headers).map(([name, value]) => [
          name,
          Array.isArray(value) ? Object.freeze([...value]) : value,
        ]),
      ),
    ),
    method: incoming.method,
    url: incoming.url,
    signal,
  });
