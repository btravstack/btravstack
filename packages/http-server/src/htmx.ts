import type { IncomingMessage, ServerResponse } from "node:http";

import { Provider } from "@btravstack/di";
import { Err, Ok, fromExecutor, type AsyncResult } from "unthrown";

import { resolvePrincipal, type AuthenticatorService } from "./auth.js";
import { matchPath } from "./fragments.js";
import { HttpHandler } from "./handler.js";
import { HtmxFragmentsPort, type FragmentAnswer } from "./htmx-controller.js";
import { HttpConfig } from "./http-config.js";

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
 * them, first match wins. Two overlapping routes (`/orders/new` and
 * `/orders/:id`) are neither sorted nor disambiguated by specificity —
 * declare the literal route first.
 */
export const htmx = (options: HtmxOptions = {}) => {
  const prefix = options.prefix ?? "/";
  return Provider.member(HttpHandler)(
    { fragments: HtmxFragmentsPort, config: HttpConfig },
    {
      sync: ({ fragments, config }) => ({
        prefix,
        handle: (request, response, _signal) =>
          respond(
            fragments.routes,
            fragments.authenticators,
            config.bodyLimit,
            prefix,
            request,
            response,
          ),
      }),
    },
  );
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
 */
const readBody = (request: IncomingMessage, limit: number): AsyncResult<string, "TooLarge"> =>
  fromExecutor<string, "TooLarge">((settle, defect) => {
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
): Promise<void> => {
  const matched = matchRoute(routes, request.method, relativePath(request.url, prefix));
  // No route claims this request: resolve unwritten so the runtime's own 404
  // answers, rather than stealing it from an answerer mounted deeper.
  if (matched === undefined) return;
  const { route, params } = matched;

  let principal: unknown;
  if (route.requirements !== undefined) {
    const resolved = await resolvePrincipal(route.requirements, authenticators, request.headers);
    if (resolved.isDefect()) {
      // oxlint-disable-next-line unthrown/no-throw -- the only way to hand a defect back to the runtime's own 500 fallback; `handle` has no returned-error channel to carry it
      throw resolved.cause;
    }
    if (resolved.isErr()) {
      refuse(response, resolved.error._tag === "UnderScoped" ? 403 : 401);
      return;
    }
    principal = resolved.value;
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

  const rendered = await route.handle(principal, params, input).get();
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(rendered.value);
};
