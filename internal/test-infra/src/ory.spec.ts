import { buildEndSessionUrl } from "openid-client";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { followRedirects } from "./ory-login.js";
import {
  ORY_CLIENT_ID,
  ORY_ISSUER,
  ORY_POST_LOGOUT_URI,
  ORY_SCOPE,
  ORY_USERS,
  provisionOry,
} from "./ory.js";

const START_UP = 180_000;

describe("the ory containers", () => {
  it(
    "answers discovery for the issuer it was started as",
    async ({ ory: _ory }) => {
      // GIVEN Hydra started with `URLS_SELF_ISSUER` on a fixed host port

      // WHEN the discovery document a client library reads is fetched
      // THEN it names that same issuer, and advertises the endpoints and the
      // PKCE method the backend-for-frontend needs
      await expect(
        fetch(new URL(".well-known/openid-configuration", ORY_ISSUER)).then((response) =>
          response.json(),
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          issuer: ORY_ISSUER,
          authorization_endpoint: `${ORY_ISSUER}oauth2/auth`,
          token_endpoint: `${ORY_ISSUER}oauth2/token`,
          end_session_endpoint: `${ORY_ISSUER}oauth2/sessions/logout`,
          code_challenge_methods_supported: expect.arrayContaining(["S256"]),
        }),
      );
    },
    START_UP,
  );

  it(
    "provisions once and attaches after",
    async ({ ory: _ory }) => {
      // GIVEN a set of containers the fixture has already provisioned
      await provisionOry();

      // WHEN the next attach provisions again, as every attach does
      // THEN the lookup finds all three, so nothing is created twice
      await expect(provisionOry()).resolves.toEqual({
        identities: { alice: "existing", bob: "existing" },
        client: "existing",
      });
    },
    START_UP,
  );

  it(
    "serves the consent handler",
    async ({ ory: _ory }) => {
      // GIVEN the endpoint Hydra's `URLS_CONSENT` redirects a browser to

      // WHEN it is asked without the challenge Hydra always sends
      const response = await fetch("http://localhost:4455/consent");

      // THEN it answers rather than refusing the connection — a handler that
      // crashed on the missing parameter would be an ECONNREFUSED here
      await expect(
        response.text().then((body) => ({ status: response.status, body })),
      ).resolves.toEqual({ status: 400, body: "missing consent_challenge" });
    },
    START_UP,
  );

  it(
    "answers a challenge Hydra does not know without taking the process with it",
    async ({ ory: _ory }) => {
      // GIVEN a challenge Hydra has never issued — a stale one, a replayed one,
      // or one minted before the memory DSN forgot it
      const status = (path: string): Promise<number> =>
        fetch(`http://localhost:4455/${path}`).then((response) => response.status);

      // WHEN both endpoints are asked with one
      const logoutStatus = await status("logout?logout_challenge=bogus");
      const consentStatus = await status("consent?consent_challenge=bogus");
      const stillUp = await status("consent").then(
        (answered) => answered === 400,
        () => false,
      );

      // THEN each answers, and the container the whole gate shares is still
      // there to answer the next request: an accept with no `redirect_to` used
      // to reach `writeHead` as `location: undefined` and exit the process
      expect({ logoutStatus, consentStatus, stillUp }).toEqual({
        logoutStatus: 400,
        consentStatus: 400,
        stillUp: true,
      });
    },
    START_UP,
  );
});

describe("the headless login", () => {
  it(
    "logs alice in and mints an ID token carrying her tenant and the scope",
    async ({ login }) => {
      // GIVEN a provisioned identity and the confidential client the
      // backend-for-frontend authenticates as

      // WHEN the authorization code flow is driven with no browser and no UI
      // application, and the code exchanged
      // THEN the ID token validates against Hydra's JWKS — its RS256 signature,
      // because the configuration enables the non-repudiation check, plus the
      // `iss`, `aud`, `exp`, `iat` and `sub` claims and the state and PKCE
      // verifier — and carries what a principal is built from, `tenant` and
      // `scope` included, neither of which Hydra puts there on its own
      await expect(login(ORY_USERS.alice).then((tokens) => tokens.claims())).resolves.toEqual(
        expect.objectContaining({
          iss: ORY_ISSUER,
          aud: [ORY_CLIENT_ID],
          sub: expect.any(String),
          tenant: ORY_USERS.alice.tenant,
          scope: ORY_SCOPE,
          sid: expect.any(String),
        }),
      );
    },
    START_UP,
  );

  it(
    "logs bob in and mints his tenant, not alice's",
    async ({ login }) => {
      // GIVEN a second identity, provisioned into a second tenant

      // WHEN he signs in through the same flow
      // THEN the claim is read off his own identity: a jar left holding alice's
      // Kratos session would have skipped the login and handed back hers
      await expect(
        login(ORY_USERS.bob).then((tokens) => tokens.claims()?.["tenant"]),
      ).resolves.toBe(ORY_USERS.bob.tenant);
    },
    START_UP,
  );

  it(
    "ends the provider session through the logout handler",
    async ({ login, oidc }) => {
      // GIVEN a browser Hydra has an OpenID session for
      const { id_token } = await login(ORY_USERS.alice);
      if (id_token === undefined)
        // oxlint-disable-next-line unthrown/no-throw -- a fixture that handed back no ID token is a broken test, not a failing one; Hydra would report it as `invalid_request` and name the wrong cause
        throw new Error("The grant answered no ID token, so there is no hint to log out with");

      // WHEN the advertised `end_session_endpoint` is followed with that jar —
      // `id_token_hint` beside the redirect because Hydra refuses one without
      // the other, `invalid_request` on its own error page
      // THEN the chain — Hydra, our own `/logout`, Hydra again — lands on the
      // registered post-logout URI rather than dead-ending at a connection
      // refused, which is what `skip_logout_consent` alone leaves it doing
      await expect(
        followRedirects(
          buildEndSessionUrl(oidc, {
            id_token_hint: id_token,
            post_logout_redirect_uri: ORY_POST_LOGOUT_URI,
          }),
          ORY_POST_LOGOUT_URI,
        ).then((landed) => landed.href),
      ).resolves.toBe(ORY_POST_LOGOUT_URI);
    },
    START_UP,
  );
});
