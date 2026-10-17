import type { IncomingMessage } from "node:http";

import type { Requirements } from "@btravstack/contract";
import { P, type AsyncResult } from "unthrown";

import {
  resolveScheme,
  type AuthenticatorService,
  type Resolved,
  type Unauthenticated,
  type UnderScoped,
} from "./auth.js";

// The request, not its eventual status, proves that authentication refused a
// verified Bearer credential. Symbol.for shares the mark across package copies,
// just as Grant's brand does; the mark lives only as long as this request.
const REFUSED: unique symbol = Symbol.for("@btravstack/http-server/insufficient-scope") as never;
type ScopedRequest = IncomingMessage & { [REFUSED]?: readonly string[] };

/** The HTTP answerers' adapter over the protocol-neutral authentication walk. */
export const resolveRequestScheme = (
  requirements: Requirements,
  authenticators: Readonly<Record<string, AuthenticatorService<unknown>>>,
  request: IncomingMessage,
): AsyncResult<Resolved, Unauthenticated | UnderScoped> => {
  delete (request as ScopedRequest)[REFUSED];
  return resolveScheme(requirements, authenticators, request.headers).mapErrCases((matcher) =>
    matcher
      .with(P.tag("Unauthenticated"), (error) => error)
      .with(P.tag("UnderScoped"), (error) => {
        if (error.scopes !== undefined) (request as ScopedRequest)[REFUSED] = error.scopes;
        return error;
      }),
  );
};

/** Safe RFC 6749 scope tokens only: custom runtime requirements are untrusted strings. */
export const scopeChallengeOf = (request: IncomingMessage): string | undefined => {
  const scopes = (request as ScopedRequest)[REFUSED];
  if (scopes === undefined) return undefined;
  const error = 'error="insufficient_scope"';
  return scopes.length > 0 && scopes.every((scope) => /^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope))
    ? `${error}, scope="${scopes.join(" ")}"`
    : error;
};
