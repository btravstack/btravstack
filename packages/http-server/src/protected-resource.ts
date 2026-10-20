import type { IncomingMessage, ServerResponse } from "node:http";

import {
  Config,
  ConfigInvalid,
  cleartext,
  cleartextRefused,
  Env,
  type EnvReading,
  type MaybePinned,
  type OptionsAs,
  type Unpinned,
} from "@btravstack/config";
import { Port, Provider, type AnyProvider, type ServiceOf } from "@btravstack/di";
import { Err, Ok, OkAsync, allAsync, type AsyncResult, type Result } from "unthrown";

import { HttpHandler, send } from "./handler.js";
import { scopeChallengeOf } from "./scope-challenge.js";

/**
 * A `WWW-Authenticate` challenge, and the request whose refusals carry it: its
 * scheme, host, path and query, as sent.
 */
export type HttpChallenge = {
  readonly target: string;
  readonly value: string;
  /** Metadata URL for typed Bearer scope refusals, set by protectedResource(). */
  readonly resourceMetadata?: string;
};

/**
 * A challenge whose target depends on the request: `resolve` answers it, or
 * `undefined` for none, and is asked only for a request whose path, as sent,
 * is `path` — settled before dispatch, so no other request waits on it. It is
 * handed the unit's signal; a client that leaves first settles the unit
 * without waiting for it, and nothing is dispatched.
 */
export type HttpRequestChallenge = {
  readonly path: string;
  readonly resolve: (
    request: IncomingMessage,
    signal: AbortSignal,
  ) => AsyncResult<HttpChallenge | undefined, never>;
};

/**
 * The challenges a `401` carries, one member per composed surface. Protected
 * resources also identify their metadata for typed Bearer scope refusals.
 * `httpServer` contributes the empty member that keeps the set from being the
 * empty dependency di refuses; an empty challenge is dropped, so a graph
 * composing no protected resource sends no header.
 *
 * A set port for `CookieSchemes`' reason: the runtime never sees what the
 * root provides beside it, so the header is a fact about the graph.
 */
export class HttpChallenges extends Port.many("HttpChallenges")<
  HttpChallenge | HttpRequestChallenge
> {}

// The raw query, `?` included: WHATWG's `search` reads `""` for a bare `?`.
const queryOf = (url: string): string => (url.includes("?") ? url.slice(url.indexOf("?")) : "");

/**
 * RFC 9728 §3.3: a client discards metadata whose `resource` is not the URL it
 * called, so a challenge answers that URL alone — not another host, not a
 * path below it or beside it (a trailing slash included), not another query.
 * A request's bare `?` reads as no query: clients disagree on sending it (Node
 * 22's fetch does not), which is also why an identifier ending in one is
 * refused at boot rather than matched loosely.
 */
/**
 * The request's path as sent. An absolute-form target is parsed for it; an
 * origin-form one is read as is, since resolving it against a base would turn
 * `//alias.test/mcp` into `/mcp` and drop a trailing slash's meaning.
 */
const requestPath = (url: string): string =>
  URL.parse(url)?.pathname ?? (url.includes("?") ? url.slice(0, url.indexOf("?")) : url);

// The query as a target compares it: a bare `?` is no query.
const comparedQuery = (url: string): string => {
  const query = queryOf(url);
  return query === "?" ? "" : query;
};

const targetOf = (scheme: string, host: string, path: string, url: string): string => {
  // Through the parser, so the authority is spelled as the resource's is: an
  // explicit default port (`api.test:443` under https) is dropped, the case folded.
  const authority = URL.parse(`${scheme}//${host}`)?.host ?? host.toLowerCase();
  return `${scheme}//${authority}${path}${comparedQuery(url)}`;
};

/**
 * Whether a request is for a target: an absolute-form target names its own
 * scheme and authority, which win over `Host`; an origin-form one names no
 * scheme — behind a proxy that terminates TLS the listener cannot know it — so
 * it is the target's own.
 */
const requestIsFor = (request: IncomingMessage): ((target: string) => boolean) => {
  const url = request.url ?? "";
  const absolute = URL.parse(url);
  const host = absolute?.host ?? request.headers.host ?? "";
  const path = requestPath(url);
  // A target carrying credentials or a fragment names another URL than any
  // resource here, neither of which the comparison below would see.
  if (
    absolute !== null &&
    (absolute.username !== "" || absolute.password !== "" || url.includes("#"))
  )
    return () => false;
  return (target) =>
    target ===
    targetOf(absolute?.protocol ?? target.slice(0, target.indexOf("//")), host, path, url);
};

/**
 * What the runtime applies to each response before dispatch: a `401` for a
 * challenge's own target carries it. A typed Bearer scope refusal gets the
 * matching resource's metadata and insufficient_scope error on its `403`.
 *
 * `writeHead` is wrapped on the response rather than the header set up front,
 * because the status is decided by whichever answerer refuses — oRPC, `htmx()`,
 * Yoga — and RFC 9728 §5.2 reads a challenge on any other response as "the
 * metadata changed, fetch it again". Node's implicit header path calls
 * `writeHead` too, so `statusCode = 401; end()` is covered.
 *
 * Answers `undefined` once they are applied or, for a request an
 * {@link HttpRequestChallenge} is due on, what applies them once it settles,
 * which the runtime awaits before dispatch.
 */
export const challengeOn = (
  challenges: readonly (HttpChallenge | HttpRequestChallenge)[],
): ((
  request: IncomingMessage,
  response: ServerResponse,
  signal: AbortSignal,
) => AsyncResult<void, never> | undefined) => {
  const fixed = challenges.filter((challenge): challenge is HttpChallenge => "value" in challenge);
  const perRequest = challenges.filter(
    (challenge): challenge is HttpRequestChallenge => "resolve" in challenge,
  );
  const challenge = applying(fixed);
  return (request, response, signal) => {
    const path = requestPath(request.url ?? "");
    const due = perRequest.filter((member) => member.path === path);
    if (due.length === 0) {
      challenge(request, response);
      return undefined;
    }
    return allAsync(due.map(({ resolve }) => resolve(request, signal))).map((resolved) =>
      applying([...fixed, ...resolved.filter((found) => found !== undefined)])(request, response),
    );
  };
};

const applying = (
  challenges: readonly HttpChallenge[],
): ((request: IncomingMessage, response: ServerResponse) => void) => {
  const live = challenges.filter(({ value }) => value !== "");
  return (request, response) => {
    const isFor = requestIsFor(request);
    const value = live
      .filter(({ target }) => isFor(target))
      .map((challenge) => challenge.value)
      .join(", ");
    if (value === "") return;
    const writeHead = response.writeHead.bind(response) as (...args: unknown[]) => ServerResponse;
    // Appended to a challenge the answerer wrote itself (`Bearer
    // error="invalid_token"`), never in its place: RFC 9728 §5.4 has discovery
    // coexist with other challenges. Headers handed to `writeHead` win over
    // `setHeader`'s, so a challenge there is appended to as well, in both forms
    // `writeHead` takes: a record, and a flat name-value list.
    const isChallenge = (name: unknown): boolean =>
      typeof name === "string" && name.toLowerCase() === "www-authenticate";
    let applied = value;
    const appended = (challenge: unknown): string => `${String(challenge)}, ${applied}`;
    const merged = (headers: unknown): unknown =>
      Array.isArray(headers)
        ? headers.map((field: unknown, at) =>
            at % 2 === 1 && isChallenge(headers[at - 1]) ? appended(field) : field,
          )
        : typeof headers === "object" && headers !== null
          ? Object.fromEntries(
              Object.entries(headers).map(([name, field]) => [
                name,
                isChallenge(name) ? appended(field) : field,
              ]),
            )
          : headers;
    response.writeHead = ((...args: unknown[]) => {
      if (args[0] === 403) {
        const scope = scopeChallengeOf(request);
        if (scope === undefined) return writeHead(...args);
        // Each composed challenge remains a complete Bearer alternative with
        // its own discovery URL, alongside any challenge the answerer wrote.
        applied = live
          .filter(({ target, resourceMetadata }) => isFor(target) && resourceMetadata !== undefined)
          .map(
            ({ resourceMetadata }) =>
              `Bearer resource_metadata="${resourceMetadata!.replace(/["\\]/g, "\\$&")}", ${scope}`,
          )
          .join(", ");
        if (applied === "") return writeHead(...args);
      } else if (args[0] !== 401) return writeHead(...args);
      const own = response.getHeader("www-authenticate");
      response.setHeader("www-authenticate", own === undefined ? applied : appended(own));
      return writeHead(...args.map((arg, at) => (at === 0 ? arg : merged(arg))));
    }) as ServerResponse["writeHead"];
  };
};

/** What {@link protectedResource} was configured with, once the boot has checked it. */
export class ProtectedResource extends Port("HttpProtectedResource")<{
  /** The resource identifier: the `aud` its tokens are minted for (RFC 8707). */
  readonly resource: string;
  readonly authorizationServers: readonly string[];
  /** Where the metadata document is served, as a client is told to fetch it. */
  readonly metadata: string;
}> {}

export type ProtectedResourceOptions = {
  /**
   * Pins `HTTP_RESOURCE_URI`: this API's resource identifier, an `https:`
   * URL — usually the audience its JWT scheme requires.
   */
  readonly resource?: string | undefined;
  /** Pins `HTTP_RESOURCE_AUTHORIZATION_SERVERS`: the issuers whose tokens it accepts. */
  readonly authorizationServers?: readonly string[] | undefined;
  /** Advertised as `scopes_supported`. Omitted from the document when absent or empty. */
  readonly scopes?: readonly string[];
  /**
   * Accept an `http:` resource or authorization server that is NOT on a
   * loopback host. Default `false`, and a `ConfigInvalid` at boot without it:
   * a client follows these URLs with its credentials.
   */
  readonly allowInsecure?: boolean;
};

const WELL_KNOWN = "/.well-known/oauth-protected-resource";

/**
 * RFC 9728 §3.1: the well-known suffix goes between the host and the
 * resource's own path and query, dropping only the slash after the host.
 */
const metadataPath = (resource: string): `/${string}` => {
  const { pathname } = new URL(resource);
  return `${WELL_KNOWN}${pathname === "/" ? "" : pathname}`;
};

// The metadata URL of a resource identifier, as a client is told to fetch it.
const metadataOf = (resource: string): string => {
  const url = new URL(resource);
  return `${url.origin}${metadataPath(url.href)}${queryOf(url.href)}`;
};

/** The challenge a `401` for a resource carries, and the `403` scope refusal's metadata. */
const challengeOf = (resource: string): HttpChallenge => {
  const url = new URL(resource);
  const metadata = metadataOf(resource);
  return {
    target: targetOf(url.protocol, url.host, url.pathname, resource),
    // RFC 9110 §5.6.4: a quoted string escapes its quotes and backslashes.
    value: `Bearer resource_metadata="${metadata.replace(/["\\]/g, "\\$&")}"`,
    resourceMetadata: metadata,
  };
};

const RESOURCE = "HTTP_RESOURCE_URI";
const SERVERS = "HTTP_RESOURCE_AUTHORIZATION_SERVERS";

/**
 * RFC 8414 §2: an issuer identifier is an absolute URL with no query and no
 * fragment, since a client derives the server's own metadata URL from it.
 */
// The raw text, not `url.search` or `url.hash`: both read `""` for a bare
// trailing `?` or `#`, which is still a component a client must reject.
const isIssuer = (server: string): boolean => {
  const url = URL.parse(server);
  // Published as written, since an issuer is compared to the server's own
  // `issuer` exactly: a spelling the parser would rewrite (whitespace, a
  // missing `//`) is refused rather than corrected, a trailing slash aside.
  return (
    url !== null &&
    (url.href === server || url.href === `${server}/`) &&
    url.username === "" &&
    url.password === "" &&
    !server.includes("?") &&
    !server.includes("#")
  );
};

// Every offending variable in one `ConfigInvalid`, so a boot names them all.
// A value stays out of every message: a URL may carry credentials.
// RFC 6749 §3.3's scope-token: printable ASCII, no space, `"` or `\`.
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

type Refused = (variable: string) => ConfigInvalid["issues"];

const refusedOn =
  (port: string, on: string): Refused =>
  (variable) =>
    cleartextRefused({
      port,
      variable,
      option: "allowInsecure",
      on,
      what: "a client sends its access token to it",
    }).issues;

const issuerAndScopeIssues = (
  authorizationServers: readonly string[],
  scopes: readonly string[],
  allowInsecure: boolean,
  refused: Refused,
): ConfigInvalid["issues"] => [
  // `Config.list` splits and trims; whether an entry is an issuer is asked here.
  ...(!authorizationServers.every(isIssuer)
    ? [
        {
          message:
            "must list issuer identifiers: absolute URLs as the parser spells them, with no credentials, query or fragment",
          path: [SERVERS],
        },
      ]
    : authorizationServers.some((server) => cleartext(server, allowInsecure) === "refused")
      ? refused(SERVERS)
      : []),
  // A scope a client would send as two, or could not send at all, is not one.
  ...(scopes.every((scope) => SCOPE_TOKEN.test(scope))
    ? []
    : [{ message: "must list OAuth scope tokens", path: ["scopes"] }]),
];

const checked = (
  resource: string,
  authorizationServers: readonly string[],
  scopes: readonly string[],
  allowInsecure: boolean,
): Result<ServiceOf<ProtectedResource>, ConfigInvalid> => {
  const refused = refusedOn("HttpProtectedResource", "protectedResource()");
  const url = new URL(resource);
  const issues = [
    // RFC 9728 §1.2: a resource identifier has no fragment, which no request carries.
    ...(resource.includes("#") ? [{ message: "must not carry a fragment", path: [RESOURCE] }] : []),
    // The document is public: credentials in the identifier would be published.
    ...(url.username === "" && url.password === ""
      ? []
      : [{ message: "must not carry credentials", path: [RESOURCE] }]),
    // RFC 3986 tells an empty query from none, and clients disagree on sending
    // it, so such an identifier could not be matched or discovered reliably.
    // Read off the parse: `mcp? ` is `mcp?` once parsed, and `mcp?tenant=?`
    // has a query that merely ends in `?`. Empty is a delimiter and nothing.
    ...(url.search === "" && url.href.includes("?")
      ? [{ message: "must not end in an empty query", path: [RESOURCE] }]
      : []),
    ...(cleartext(resource, allowInsecure) === "refused" ? refused(RESOURCE) : []),
    ...issuerAndScopeIssues(authorizationServers, scopes, allowInsecure, refused),
  ];
  // Published as serialized, so the document, the challenge and the URL a
  // client requests all spell it the same way (`東京` percent-encoded).
  return issues.length === 0
    ? Ok({ resource: url.href, authorizationServers, metadata: metadataOf(url.href) })
    : Err(new ConfigInvalid({ port: "HttpProtectedResource", issues }));
};

/** The provider of {@link ProtectedResource}, its variables required unless pinned. */
export type ProtectedResourceProvider<O> = Provider<
  ProtectedResource,
  ConfigInvalid,
  EnvReading<
    | Unpinned<O, "resource", "HTTP_RESOURCE_URI">
    | Unpinned<O, "authorizationServers", "HTTP_RESOURCE_AUTHORIZATION_SERVERS">,
    | MaybePinned<O, "resource", "HTTP_RESOURCE_URI">
    | MaybePinned<O, "authorizationServers", "HTTP_RESOURCE_AUTHORIZATION_SERVERS">
  >
>;

/**
 * This API as an OAuth 2.0 protected resource: it serves its Protected
 * Resource Metadata (RFC 9728) and tells a refused caller where to find it, so
 * a client that holds no token — an MCP client is the usual one — discovers
 * which authorization server to sign in with.
 *
 * ```ts
 * export const Api = HttpModule("Api")({
 *   router,
 *   provides: [...protectedResource({ scopes: ["orders:read"] })],
 * });
 * ```
 *
 * - `GET /.well-known/oauth-protected-resource<path>` answers the document:
 *   `resource`, `authorization_servers` and, when
 *   given, `scopes_supported`. `<path>` is the resource identifier's own, so a
 *   resource at `https://api.test/mcp` is described at
 *   `/.well-known/oauth-protected-resource/mcp`.
 * - A `401` for the resource's own URL carries
 *   `WWW-Authenticate: Bearer resource_metadata="<that URL>"`, whichever
 *   answerer refused — oRPC, GraphQL or fragments — without any of them
 *   knowing. Any other URL, a path below it or another query included, is
 *   another resource, whose metadata this is not (RFC 9728 §3.3).
 *
 * It answers THREE providers, which is why it is spread: the configuration,
 * the answerer and the {@link HttpChallenges} member.
 */
export const protectedResource = <const O extends ProtectedResourceOptions = Record<never, never>>(
  given?: O & OptionsAs<O, ProtectedResourceOptions>,
): readonly [ProtectedResourceProvider<O>, AnyProvider, AnyProvider] => {
  const options: ProtectedResourceOptions = given ?? {};
  const schema = Config.object({
    resource: Config.pinned(options.resource, Config.url(RESOURCE)),
    authorizationServers: Config.pinned(options.authorizationServers, Config.list(SERVERS)),
  });
  const configuration = Provider(ProtectedResource)({
    inject: { env: Env },
    make: ({ env }) =>
      Config.parse(
        "HttpProtectedResource",
        schema,
      )(env).flatMap(({ resource, authorizationServers }) =>
        checked(
          resource,
          authorizationServers,
          options.scopes ?? [],
          options.allowInsecure ?? false,
        ),
      ),
  });
  const answerer = Provider.member(HttpHandler)({
    inject: { bound: ProtectedResource },
    sync: ({ bound }) => {
      const body = JSON.stringify({
        resource: bound.resource,
        authorization_servers: bound.authorizationServers,
        // RFC 9728 §3.2: a parameter with zero values is omitted.
        ...(options.scopes?.length ? { scopes_supported: options.scopes } : {}),
      });
      const prefix = metadataPath(bound.resource);
      // The document describes one resource (RFC 9728 §3.3): its metadata URL
      // under another scheme, host or query derives another resource.
      const url = new URL(bound.resource);
      const target = targetOf(url.protocol, url.host, prefix, bound.resource);
      return {
        prefix,
        handle: (request, response) => {
          if (request.method === "GET" && requestIsFor(request)(target)) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(body);
          } else send(response, 404);
          return Promise.resolve();
        },
      };
    },
  });
  const challenge = Provider.member(HttpChallenges)({
    inject: { bound: ProtectedResource },
    sync: ({ bound }) => challengeOf(bound.resource),
  });
  // Cast for the needs alone: over generic options the schema's own needs type
  // cannot resolve, so `ProtectedResourceProvider` states the two variables.
  return [configuration as unknown as ProtectedResourceProvider<O>, answerer, challenge];
};

/**
 * Whether this deployment serves a host — usually a domain a tenant verified,
 * kept in the application's own data. Asked with the host as the URL parser
 * spells it: lowercase, punycode, the scheme's default port dropped and any
 * other port kept (`tenant-a.example`, `localhost:3000`), and the request
 * unit's signal, aborted once the unit settles — a client that left included —
 * so a query can be cancelled.
 */
export class ServedHosts extends Port("HttpServedHosts")<
  (host: string, signal: AbortSignal) => AsyncResult<boolean, never>
> {}

/** What {@link protectedResourcePerHost} was configured with, once the boot has checked it. */
export class ProtectedResourcePerHost extends Port("HttpProtectedResourcePerHost")<{
  /** The resource's path on every served host, as the URL parser spells it. */
  readonly path: string;
  readonly authorizationServers: readonly string[];
}> {}

export type ProtectedResourcePerHostOptions = {
  /** Pins `HTTP_RESOURCE_PATH`: the resource's path on every served host, `/mcp` for one. */
  readonly path?: string | undefined;
  /** Pins `HTTP_RESOURCE_AUTHORIZATION_SERVERS`: the issuers whose tokens it accepts. */
  readonly authorizationServers?: readonly string[] | undefined;
  /** Advertised as `scopes_supported`. Omitted from the document when absent or empty. */
  readonly scopes?: readonly string[];
  /**
   * Accept an `http:` authorization server, or an `http:` request target,
   * that is NOT on a loopback host. Default `false`: a client follows these
   * URLs with its credentials.
   */
  readonly allowInsecure?: boolean;
};

const PATH = "HTTP_RESOURCE_PATH";

/** The provider of {@link ProtectedResourcePerHost}, its variables required unless pinned. */
export type ProtectedResourcePerHostProvider<O> = Provider<
  ProtectedResourcePerHost,
  ConfigInvalid,
  EnvReading<
    | Unpinned<O, "path", "HTTP_RESOURCE_PATH">
    | Unpinned<O, "authorizationServers", "HTTP_RESOURCE_AUTHORIZATION_SERVERS">,
    | MaybePinned<O, "path", "HTTP_RESOURCE_PATH">
    | MaybePinned<O, "authorizationServers", "HTTP_RESOURCE_AUTHORIZATION_SERVERS">
  >
>;

/**
 * The resource a request names under `path`: the request's own origin, its
 * host from an absolute-form target or else `Host`. An origin-form request
 * names no scheme, so it is `https:` — the listener speaks only cleartext,
 * which a client reaches directly on a loopback host alone, so there `http:`.
 */
const requestResource = (
  request: IncomingMessage,
  path: string,
  allowInsecure: boolean,
): { readonly host: string; readonly resource: string } | undefined => {
  const absolute = URL.parse(request.url ?? "");
  const host = absolute?.host ?? request.headers.host ?? "";
  const direct = URL.parse(`http://${host}`);
  if (direct === null) return undefined;
  const scheme =
    absolute?.protocol ?? (cleartext(direct.href, false) === true ? "http:" : "https:");
  const origin = URL.parse(`${scheme}//${host}`);
  return origin === null || cleartext(origin.href, allowInsecure) === "refused"
    ? undefined
    : { host: origin.host, resource: `${origin.protocol}//${origin.host}${path}` };
};

/**
 * This API as an OAuth 2.0 protected resource on every host the application
 * serves — one resource per tenant domain, say — rather than on one
 * configured URL: {@link protectedResource}'s discovery, with the resource
 * identifier `<scheme>//<request host><path>` derived per request.
 *
 * ```ts
 * export const Api = HttpModule("Api")({
 *   router,
 *   provides: [...protectedResourcePerHost({ path: "/mcp" }), servedHosts],
 * });
 * ```
 *
 * The host is admitted only when {@link ServedHosts} answers `true`: an
 * unserved host gets a `404` for the metadata document and no challenge, so a
 * forged `Host` never mints discovery for a domain the application did not
 * vouch for. It is asked at most once per request to the resource or its metadata,
 * and only for those. Every matching rule of {@link protectedResource}'s
 * holds per host.
 *
 * It answers THREE providers, which is why it is spread: the configuration,
 * the answerer and the {@link HttpChallenges} member.
 */
export const protectedResourcePerHost = <
  const O extends ProtectedResourcePerHostOptions = Record<never, never>,
>(
  given?: O & OptionsAs<O, ProtectedResourcePerHostOptions>,
): readonly [
  ProtectedResourcePerHostProvider<O>,
  Provider<HttpHandler, never, ProtectedResourcePerHost | ServedHosts>,
  Provider<HttpChallenges, never, ProtectedResourcePerHost | ServedHosts>,
] => {
  const options: ProtectedResourcePerHostOptions = given ?? {};
  const allowInsecure = options.allowInsecure ?? false;
  const schema = Config.object({
    path: Config.pinned(options.path, Config.string(PATH)),
    authorizationServers: Config.pinned(options.authorizationServers, Config.list(SERVERS)),
  });
  const configuration = Provider(ProtectedResourcePerHost)({
    inject: { env: Env },
    make: ({ env }) =>
      Config.parse(
        "HttpProtectedResourcePerHost",
        schema,
      )(env).flatMap(({ path, authorizationServers }) => {
        const issues = [
          // Matched as sent, so a spelling the parser would rewrite matches nothing.
          ...(URL.parse(path, "https://resource.invalid")?.pathname === path
            ? []
            : [
                {
                  message:
                    "must be an absolute path as the URL parser spells it, with no query or fragment",
                  path: [PATH],
                },
              ]),
          ...issuerAndScopeIssues(
            authorizationServers,
            options.scopes ?? [],
            allowInsecure,
            refusedOn("HttpProtectedResourcePerHost", "protectedResourcePerHost()"),
          ),
        ];
        return issues.length === 0
          ? Ok({ path, authorizationServers })
          : Err(new ConfigInvalid({ port: "HttpProtectedResourcePerHost", issues }));
      }),
  });
  const answerer = Provider.member(HttpHandler)({
    inject: { bound: ProtectedResourcePerHost, served: ServedHosts },
    sync: ({ bound, served }) => {
      const prefix = metadataPath(`https://resource.invalid${bound.path}`);
      return {
        prefix,
        handle: async (request, response, signal) => {
          const named =
            request.method === "GET"
              ? requestResource(request, bound.path, allowInsecure)
              : undefined;
          // The document describes one resource (RFC 9728 §3.3), so its URL is
          // matched exactly before the host is even asked about.
          if (named === undefined || !requestIsFor(request)(metadataOf(named.resource))) {
            send(response, 404);
            return;
          }
          const answered = await served(named.host, signal).map((vouched) => {
            if (!vouched) return send(response, 404);
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                resource: named.resource,
                authorization_servers: bound.authorizationServers,
                ...(options.scopes?.length ? { scopes_supported: options.scopes } : {}),
              }),
            );
          });
          if (answered.isDefect()) {
            // oxlint-disable-next-line unthrown/no-throw -- a handler has no defect channel: this is the runtime's 500
            throw answered.cause;
          }
        },
      };
    },
  });
  const challenge = Provider.member(HttpChallenges)({
    inject: { bound: ProtectedResourcePerHost, served: ServedHosts },
    sync: ({ bound, served }) => ({
      path: bound.path,
      resolve: (request: IncomingMessage, signal: AbortSignal) => {
        const named = requestResource(request, bound.path, allowInsecure);
        return named === undefined || !requestIsFor(request)(named.resource)
          ? OkAsync(undefined)
          : served(named.host, signal).map((vouched) =>
              vouched ? challengeOf(named.resource) : undefined,
            );
      },
    }),
  });
  // Cast for the needs alone, as protectedResource()'s is.
  return [configuration as unknown as ProtectedResourcePerHostProvider<O>, answerer, challenge];
};
