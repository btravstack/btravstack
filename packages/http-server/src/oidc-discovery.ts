import {
  ClientSecretBasic,
  allowInsecureRequests,
  discovery,
  enableNonRepudiationChecks,
  type Configuration,
} from "openid-client";
import { TaggedError, fromPromise, type AsyncResult } from "unthrown";

/**
 * Discovery did not answer, at boot. `cause` is whatever `openid-client`
 * rejected with — a connection refused, a document that is not one, a 404 on
 * `.well-known` — kept whole rather than flattened to a message, since the
 * three read very differently to whoever is fixing the deployment.
 */
export class OidcUnreachable extends TaggedError("OidcUnreachable")<{
  readonly issuer: string;
  readonly cause: unknown;
}> {}

/**
 * The discovery document, once, at boot — so a provider that is not there is a
 * typed startup failure rather than a 500 on the first login, and so the JWKS
 * cache and the metadata are one per process rather than one per request.
 */
export const discoverOidc = (
  issuer: string,
  clientId: string,
  clientSecret: string,
  // `http:` AND (loopback or the opt-in) — decided at boot by `insecureIssuer`
  // below, never re-derived here, so the check that refuses a cleartext issuer
  // and the switch that permits one cannot drift apart.
  insecure: boolean,
): AsyncResult<Configuration, OidcUnreachable> =>
  fromPromise(
    discovery(new URL(issuer), clientId, undefined, ClientSecretBasic(clientSecret), {
      execute: insecure ? [allowInsecureRequests] : [],
    }),
    (cause) => new OidcUnreachable({ issuer, cause }),
  ).map((config) => {
    // Applied TWICE for a permitted plaintext issuer: as a `discovery` option
    // and again on the configuration it answers, which that option does not
    // reach.
    if (insecure) allowInsecureRequests(config);
    // Without this nothing verifies the ID token's SIGNATURE: OIDC Core lets a
    // client trust a token that arrived over TLS from the token endpoint.
    enableNonRepudiationChecks(config);
    return config;
  });
