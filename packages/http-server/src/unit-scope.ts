import type { UnitHost } from "@btravstack/core";
import type { Context, Module } from "@btravstack/di";

/**
 * Forks the unit's scope for the request oRPC is about to handle, and puts
 * the forked context on the procedure's context as `unit`. Installed on every
 * leaf, after `principalMiddleware` where there is one, so a later phase can
 * seed it with what the principal resolved to.
 */
export const unitScope =
  (module: Module<unknown, never, unknown> | undefined) =>
  async (options: {
    readonly context: { readonly host: UnitHost<never> };
    readonly next: (injected: {
      readonly context: { readonly unit: Context<never> | undefined };
    }) => Promise<unknown>;
  }): Promise<unknown> => {
    if (module === undefined) return await options.next({ context: { unit: undefined } });
    // `.get()` on an `AsyncResult<T, never>` rethrows a defect's own cause,
    // which is how it reaches oRPC — the middleware protocol has no returned-
    // error arm of its own.
    const unit = await options.context.host.fork(module as never, []).get();
    return await options.next({ context: { unit: unit as Context<never> } });
  };
