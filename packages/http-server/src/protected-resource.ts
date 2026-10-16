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
import { Err, Ok, type Result } from "unthrown";

import { HttpHandler, pathUnder, send } from "./handler.js";

/**
 * A `WWW-Authenticate` challenge, and the request whose refusals carry it: its
 * scheme, host, path and query, as sent.
 */
export type HttpChallenge = { readonly target: string; readonly value: string };

/**
 * The challenges a `401` carries, one member per composed surface.
 * `httpServer` contributes the empty member that keeps the set from being the
 * empty dependency di refuses; an empty challenge is dropped, so a graph
 * composing no protected resource sends no header.
 *
 * A set port for `CookieSchemes`' reason: the runtime never sees what the
 * root provides beside it, so the header is a fact about the graph.
 */
export class HttpChallenges extends Port.many("HttpChallenges")<HttpChallenge> {}

// The raw query, `?` included: WHATWG's `search` reads `""` for a bare `?`.
const queryOf = (url: string): string => (url.includes("?") ? url.slice(url.indexOf("?")) : "");

/**
 * RFC 9728 §3.3: a client discards metadata whose `resource` is not the URL it
 * called, so a challenge answers that URL alone — not another host, not a
 * path below it or beside it (a trailing slash included), not another query.
 * A bare `?` is the one thing dropped: clients disagree on sending it (Node
 * 22's fetch does not), and it names no other resource.
 */
const targetOf = (scheme: string, host: string, path: string, url: string): string => {
  const query = queryOf(url);
  return `${scheme}//${host.toLowerCase()}${path}${query === "?" ? "" : query}`;
};

/**
 * What the runtime applies to each response before dispatch: a `401` for a
 * challenge's own target carries it, and nothing else does.
 *
 * `writeHead` is wrapped on the response rather than the header set up front,
 * because the status is decided by whichever answerer refuses — oRPC, `htmx()`,
 * Yoga — and RFC 9728 §5.2 reads a challenge on any other response as "the
 * metadata changed, fetch it again". Node's implicit header path calls
 * `writeHead` too, so `statusCode = 401; end()` is covered.
 */
export const challengeOn = (
  challenges: readonly HttpChallenge[],
): ((request: IncomingMessage, response: ServerResponse) => void) => {
  const live = challenges.filter(({ value }) => value !== "");
  return (request, response) => {
    // An absolute-form target names its own scheme and authority, which win
    // over `Host`. An origin-form one names no scheme — behind a proxy that
    // terminates TLS the listener cannot know it — so it is the challenge's.
    const absolute = URL.parse(request.url ?? "");
    const host = absolute?.host ?? request.headers.host ?? "";
    const path = pathUnder(request.url, "/");
    const value = live
      .filter(({ target }) => {
        const scheme = absolute?.protocol ?? target.slice(0, target.indexOf("//"));
        return target === targetOf(scheme, host, path, request.url ?? "");
      })
      .map((challenge) => challenge.value)
      .join(", ");
    if (value === "") return;
    const writeHead = response.writeHead.bind(response) as (...args: unknown[]) => ServerResponse;
    response.writeHead = ((...args: unknown[]) => {
      if (args[0] === 401 && !response.hasHeader("www-authenticate"))
        response.setHeader("www-authenticate", value);
      return writeHead(...args);
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
const checked = (
  resource: string,
  authorizationServers: readonly string[],
  allowInsecure: boolean,
): Result<ServiceOf<ProtectedResource>, ConfigInvalid> => {
  const refused = (variable: string) =>
    cleartextRefused({
      port: "HttpProtectedResource",
      variable,
      option: "allowInsecure",
      on: "protectedResource()",
      what: "a client sends its access token to it",
    }).issues;
  const url = new URL(resource);
  const issues = [
    // RFC 9728 §1.2: a resource identifier has no fragment, which no request carries.
    ...(resource.includes("#") ? [{ message: "must not carry a fragment", path: [RESOURCE] }] : []),
    // The document is public: credentials in the identifier would be published.
    ...(url.username === "" && url.password === ""
      ? []
      : [{ message: "must not carry credentials", path: [RESOURCE] }]),
    ...(cleartext(resource, allowInsecure) === "refused" ? refused(RESOURCE) : []),
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
  ];
  // Published as serialized, so the document, the challenge and the URL a
  // client requests all spell it the same way (`東京` percent-encoded).
  return issues.length === 0
    ? Ok({
        resource: url.href,
        authorizationServers,
        metadata: `${url.origin}${metadataPath(url.href)}${queryOf(url.href)}`,
      })
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
        checked(resource, authorizationServers, options.allowInsecure ?? false),
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
      return {
        prefix,
        handle: (request, response) => {
          if (request.method === "GET" && pathUnder(request.url, prefix) === "/") {
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
    sync: ({ bound }) => ({
      target: targetOf(
        new URL(bound.resource).protocol,
        new URL(bound.resource).host,
        new URL(bound.resource).pathname,
        bound.resource,
      ),
      // RFC 9110 §5.6.4: a quoted string escapes its quotes and backslashes.
      value: `Bearer resource_metadata="${bound.metadata.replace(/["\\]/g, "\\$&")}"`,
    }),
  });
  // Cast for the needs alone: over generic options the schema's own needs type
  // cannot resolve, so `ProtectedResourceProvider` states the two variables.
  return [configuration as unknown as ProtectedResourceProvider<O>, answerer, challenge];
};
