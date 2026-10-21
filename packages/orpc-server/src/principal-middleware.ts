import type { IncomingMessage } from "node:http";

import type { Requirements } from "@btravstack/contract";
import type { Observers } from "@btravstack/core";
import type { ServiceOf } from "@btravstack/di";
import {
  principalOf,
  resolveRequestScheme,
  type AuthenticatorService,
  type Resolved,
} from "@btravstack/http-server/internal";
import { ORPCError } from "@orpc/server";

/**
 * The one middleware this package installs, and only on a leaf whose
 * requirements say so — oRPC's adapter over {@link resolvePrincipal}. It reads
 * the request from oRPC's initial context, which is what initial context is for.
 */
export const principalMiddleware =
  (
    requirements: Requirements,
    authenticators: Readonly<Record<string, AuthenticatorService<unknown>>>,
  ) =>
  async (options: {
    readonly context: {
      readonly request: IncomingMessage;
      readonly observers?: ServiceOf<typeof Observers>;
    };
    readonly next: (injected: {
      readonly context: { readonly principal: unknown; readonly resolved: Resolved };
    }) => Promise<unknown>;
  }): Promise<unknown> => {
    const resolved = await resolveRequestScheme(
      requirements,
      authenticators,
      options.context.request,
      options.context.observers,
    );
    if (resolved.isDefect()) {
      // oxlint-disable-next-line unthrown/no-throw -- the only way to hand a defect back to oRPC, whose middleware protocol has no returned-error arm
      throw resolved.cause;
    }
    if (resolved.isErr()) {
      // No message: oRPC serializes `message` to the client, and a refusal has
      // nothing a caller is entitled to.
      // oxlint-disable-next-line unthrown/no-throw -- oRPC terminates a request by throwing an ORPCError; its middleware protocol has no returned-error arm
      throw new ORPCError(
        resolved.error._tag === "AuthenticatorUnavailable"
          ? "SERVICE_UNAVAILABLE"
          : resolved.error._tag === "UnderScoped"
            ? "FORBIDDEN"
            : "UNAUTHORIZED",
        { cause: resolved.error },
      );
    }
    return await options.next({
      context: {
        principal: principalOf(requirements, resolved.value),
        resolved: resolved.value,
      },
    });
  };
