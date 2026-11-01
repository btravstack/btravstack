import { buildEndSessionUrl, type Configuration } from "openid-client";

import type { OidcLogoutContext } from "./oidc-token-store.js";

export function logoutLocation(
  configuration: Configuration,
  fallback: string,
  redirectUri: string | undefined,
  context: OidcLogoutContext | undefined,
): string {
  if (configuration.serverMetadata().end_session_endpoint === undefined) return fallback;
  return buildEndSessionUrl(
    configuration,
    context === undefined || redirectUri === undefined
      ? {}
      : {
          id_token_hint: context.idToken,
          post_logout_redirect_uri: redirectUri,
        },
  ).href;
}
