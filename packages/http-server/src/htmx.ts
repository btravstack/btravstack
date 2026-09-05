import type { IncomingMessage, ServerResponse } from "node:http";

import type { UnitHost } from "@btravstack/core";
import { Provider, type AnyPort, type Context } from "@btravstack/di";
import { Err, Ok, P, fromExecutor, type AsyncResult } from "unthrown";

import { principalOf, resolveScheme, type AuthenticatorService, type Resolved } from "./auth.js";
import { matchPath } from "./fragments.js";
import { HttpHandler } from "./handler.js";
import { HtmxFragmentsPort, type FragmentAnswer } from "./htmx-route.js";
import { HttpConfig } from "./http-config.js";
import { HttpUnit, type AnyUnitModule } from "./http-runtime.js";
import { seedOf } from "./unit-scope.js";
import { unitRecordOf } from "./unit.js";

export type HtmxOptions = {
  /** Where fragments are mounted. Default `/`. */
  readonly prefix?: `/${string}`;
};

/**
 * The htmx starter: fragments, as ONE answerer under the HTTP runtime. A
 * request no route claims — outside every path, or on a path whose only
 * route names a different method — resolves unwritten and the runtime
 * answers its own `404`.
 *
 * `routes` is matched in the ORDER the composition root's piece array gave
 * them, first match wins — and that ordering is a SECURITY property, not
 * only a routing one. A public route declared BEFORE a requires-carrying
 * route whose path can also match the same request answers it itself, and no
 * authentication ever runs: two routes are two port ids, minted from their
 * own method and path, so di has nothing to see collide, and a specificity
 * rule is deliberately not provided (the ordering is the composition root's,
 * on purpose). Declare a route that requires authentication before any
 * public route whose path could also match its requests.
 */
export const htmx = (options: HtmxOptions = {}) => {
  const prefix = options.prefix ?? "/";
  return Provider.member(HttpHandler)({
    inject: { fragments: HtmxFragmentsPort, config: HttpConfig, unit: HttpUnit },
    sync: ({ fragments, config, unit }) => ({
      prefix,
      handle: (request, response, _signal, host) =>
        respond(
          fragments.routes,
          fragments.authenticators,
          config.bodyLimit,
          prefix,
          request,
          response,
          host,
          unit,
          fragments.principals,
        ),
    }),
  });
};

/** The route a request matches, and the parameters its path bound. */
type Matched = {
  readonly route: FragmentAnswer;
  readonly params: Readonly<Record<string, string>>;
};

const matchRoute = (
  routes: readonly FragmentAnswer[],
  method: string | undefined,
  path: string,
): Matched | undefined => {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPath(route.path, path);
    if (params !== undefined) return { route, params };
  }
  return undefined;
};

/** `request.url` relative to the mount, query string dropped. */
const relativePath = (url: string | undefined, prefix: `/${string}`): string => {
  const full = (url ?? "/").split("?")[0] ?? "/";
  const mount = prefix.replace(/\/+$/, "");
  const rest = full.slice(mount.length);
  return rest === "" ? "/" : rest;
};

/**
 * The body, read while enforcing `limit` as bytes arrive rather than after
 * buffering it whole — the only shape that actually bounds memory. `0` is
 * unbounded. Over the limit, bytes stop being kept but keep being drained
 * (never `request.destroy()`): destroying an `IncomingMessage` destroys the
 * SOCKET it arrived on, taking the response meant to carry the 413 down with
 * it. A genuine stream fault settles the defect channel; nothing here models
 * it, since it is a bug in the transport rather than an oversized caller.
 *
 * `request` may already be destroyed or ended by the time this subscribes —
 * `respond` reaches here only after `await`ing authentication first for a
 * marked route, and a client that aborts during that await leaves Node's own
 * `abortIncoming` destroying the stream with no `'error'` listener attached
 * to hear it, which SUPPRESSES the emit entirely (measured against Node's
 * `_http_incoming`). Subscribing to a stream that already fired is this
 * package's own documented footgun (`closedOf` in `http-runtime.ts`), and
 * missing it here would leave `readBody`'s promise — and the request, its
 * listeners and `chunks` — open for the process lifetime. The guard below,
 * plus `'close'` (which still fires on a stream `'end'` already settled, but
 * the once-only latch makes that a no-op), are what close it.
 */
const readBody = (request: IncomingMessage, limit: number): AsyncResult<string, "TooLarge"> =>
  fromExecutor<string, "TooLarge">((settle, defect) => {
    if (request.destroyed || request.readableEnded) {
      settle(defect(new Error("the request stream ended before its body was read")));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // `settle` is a once-only latch (unthrown's own guarantee), so an
      // over-limit request keeps draining harmlessly through this same branch
      // on every later chunk instead of needing to be unsubscribed.
      if (limit !== 0 && size > limit) {
        settle(Err("TooLarge"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => settle(Ok(Buffer.concat(chunks).toString("utf8"))));
    request.on("error", (cause) => settle(defect(cause)));
    request.on("close", () => settle(defect(new Error("the request closed before it ended"))));
  });

// No body on a refusal: it owes the caller nothing beyond the status.
const refuse = (response: ServerResponse, status: number): void => {
  response.writeHead(status);
  response.end();
};

const respond = async (
  routes: readonly FragmentAnswer[],
  authenticators: Readonly<Record<string, AuthenticatorService<unknown>>>,
  bodyLimit: number,
  prefix: `/${string}`,
  request: IncomingMessage,
  response: ServerResponse,
  host: UnitHost<never>,
  units: Readonly<Record<string, AnyUnitModule>>,
  principals: Readonly<Record<string, AnyPort>>,
): Promise<void> => {
  const matched = matchRoute(routes, request.method, relativePath(request.url, prefix));
  // No route claims this request: resolve unwritten so the runtime's own 404
  // answers, rather than stealing it from an answerer mounted deeper.
  if (matched === undefined) return;
  const { route, params } = matched;

  let principal: unknown;
  let authenticated: Resolved | undefined;
  if (route.requirements !== undefined) {
    // Exhaustive on `resolveScheme`'s Err union: a third case added there
    // fails this compile rather than silently falling through to 401.
    const resolved = await resolveScheme(
      route.requirements,
      authenticators,
      request.headers,
    ).mapErrCases((matcher) =>
      matcher
        .with(P.tag("Unauthenticated"), () => 401 as const)
        .with(P.tag("UnderScoped"), () => 403 as const),
    );
    if (resolved.isDefect()) {
      // oxlint-disable-next-line unthrown/no-throw -- the only way to hand a defect back to the runtime's own 500 fallback; `handle` has no returned-error channel to carry it
      throw resolved.cause;
    }
    if (resolved.isErr()) {
      refuse(response, resolved.error);
      return;
    }
    authenticated = resolved.value;
    principal = principalOf(route.requirements, resolved.value);
  }

  let input: unknown = {};
  if (request.method === "POST") {
    const read = await readBody(request, bodyLimit);
    if (read.isDefect()) {
      // oxlint-disable-next-line unthrown/no-throw -- same as above: a genuine stream fault, not a modeled outcome
      throw read.cause;
    }
    if (read.isErr()) {
      refuse(response, 413);
      return;
    }
    const decoded = Object.fromEntries(new URLSearchParams(read.value));
    if (route.input === undefined) {
      input = decoded;
    } else {
      const validated = await route.input["~standard"].validate(decoded);
      if (validated.issues !== undefined) {
        refuse(response, 422);
        return;
      }
      input = validated.value;
    }
  }

  // Forked here — after authentication has succeeded and the body has
  // validated, immediately before the handler — so a refused or malformed
  // request never opens a scope: the same point in the request's life oRPC's
  // own `unitScope` forks at, since `principalMiddleware` short-circuits
  // without calling `next()` on a refusal, and `unitScope` sits inside it.
  const module = units[authenticated?.scheme ?? "anonymous"] ?? units["anonymous"];
  // Nothing forked is an empty record rather than an absent one: `UnitFor`
  // hides every name in that case, so a handler has nothing to read anyway.
  let unit: Readonly<Record<string, unknown>> = {};
  if (module !== undefined) {
    // `as never` on both: see `unit-scope.ts`'s own comment on the identical
    // pair of casts — `AnyUnitModule` erases the module's Needs to `unknown`,
    // which `fork`'s `DependencyGate` can never clear on its own, and the seed
    // is keyed by a runtime scheme name. The check already ran once, at the
    // `Units`-generic call site that bound this module.
    const scope = await host.fork(module as never, seedOf(principals, authenticated) as never);
    if (scope.isDefect()) {
      refuse(response, 500);
      return;
    }
    unit = unitRecordOf(scope.get() as Context<never>, route.unit);
  }

  const rendered = await route.handle({ principal, unit }, params, input).get();
  // Unconditional, not keyed on `route.requirements`: a public route can
  // still render caller- or resource-scoped HTML (a path parameter alone is
  // enough), and this package has no way to know a route is safe to cache.
  // A shared cache heuristically stores a bare 200 GET with no directive.
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(rendered.value);
};
