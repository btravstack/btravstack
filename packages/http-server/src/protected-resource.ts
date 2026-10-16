import {
  Config,
  cleartext,
  cleartextRefused,
  Env,
  type ConfigInvalid,
  type EnvReading,
  type MaybePinned,
  type OptionsAs,
  type Unpinned,
} from "@btravstack/config";
import { Port, Provider, type AnyProvider, type ServiceOf } from "@btravstack/di";
import { Err, Ok, type Result } from "unthrown";

import { HttpHandler, pathUnder, send } from "./handler.js";

/**
 * The challenges every response carries in `WWW-Authenticate`, one member per
 * composed surface. `httpServer` contributes the empty member that keeps the
 * set from being the empty dependency di refuses; an empty challenge is
 * dropped, so a graph composing no protected resource sends no header.
 *
 * A set port for `CookieSchemes`' reason: the runtime never sees what the
 * root provides beside it, so the header is a fact about the graph.
 */
export class HttpChallenges extends Port.many("HttpChallenges")<string> {}

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
  /** Advertised as `scopes_supported`. Omitted from the document when absent. */
  readonly scopes?: readonly string[];
  /**
   * Accept an `http:` resource or authorization server that is NOT on a
   * loopback host. Default `false`, and a `ConfigInvalid` at boot without it:
   * a client follows these URLs with its credentials.
   */
  readonly allowInsecure?: boolean;
};

const WELL_KNOWN = "/.well-known/oauth-protected-resource";

/** RFC 9728 §3.1: the well-known suffix goes between the host and the resource's own path. */
const metadataPath = (resource: string): `/${string}` => {
  const path = new URL(resource).pathname.replace(/\/+$/, "");
  return `${WELL_KNOWN}${path}`;
};

const checked = (
  resource: string,
  authorizationServers: readonly string[],
  allowInsecure: boolean,
): Result<ServiceOf<ProtectedResource>, ConfigInvalid> => {
  const refused = (variable: string) =>
    Err(
      cleartextRefused({
        port: "HttpProtectedResource",
        variable,
        option: "allowInsecure",
        on: "protectedResource()",
        what: "a client sends its access token to it",
      }),
    );
  if (cleartext(resource, allowInsecure) === "refused") return refused("HTTP_RESOURCE_URI");
  if (authorizationServers.some((server) => cleartext(server, allowInsecure) === "refused"))
    return refused("HTTP_RESOURCE_AUTHORIZATION_SERVERS");
  return Ok({
    resource,
    authorizationServers,
    metadata: new URL(metadataPath(resource), resource).href,
  });
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
 * Resource Metadata (RFC 9728) and challenges every caller with where to find
 * it, so a client that holds no token — an MCP client is the usual one —
 * discovers which authorization server to sign in with.
 *
 * ```ts
 * export const Api = HttpModule("Api")({
 *   router,
 *   provides: [...protectedResource({ scopes: ["orders:read"] })],
 * });
 * ```
 *
 * - `GET /.well-known/oauth-protected-resource<path>` answers the document:
 *   `resource`, `authorization_servers`, `bearer_methods_supported` and, when
 *   given, `scopes_supported`. `<path>` is the resource identifier's own, so a
 *   resource at `https://api.test/mcp` is described at
 *   `/.well-known/oauth-protected-resource/mcp`.
 * - Every response carries
 *   `WWW-Authenticate: Bearer resource_metadata="<that URL>"`. RFC 9110 §11.6.1
 *   requires it on a `401` and permits it elsewhere; setting it before
 *   dispatch is what reaches the `401` of every answerer, oRPC, GraphQL and
 *   fragments alike, without any of them knowing.
 *
 * It answers THREE providers, which is why it is spread: the configuration,
 * the answerer and the {@link HttpChallenges} member.
 */
export const protectedResource = <const O extends ProtectedResourceOptions = Record<never, never>>(
  given?: O & OptionsAs<O, ProtectedResourceOptions>,
): readonly [ProtectedResourceProvider<O>, AnyProvider, AnyProvider] => {
  const options: ProtectedResourceOptions = given ?? {};
  const schema = Config.object({
    resource: Config.pinned(options.resource, Config.url("HTTP_RESOURCE_URI")),
    authorizationServers: Config.pinned(
      options.authorizationServers,
      Config.list("HTTP_RESOURCE_AUTHORIZATION_SERVERS"),
    ),
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
        bearer_methods_supported: ["header"],
        ...(options.scopes === undefined ? {} : { scopes_supported: options.scopes }),
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
    sync: ({ bound }) => `Bearer resource_metadata="${bound.metadata}"`,
  });
  // Cast for the needs alone: over generic options the schema's own needs type
  // cannot resolve, so `ProtectedResourceProvider` states the two variables.
  return [configuration as unknown as ProtectedResourceProvider<O>, answerer, challenge];
};
