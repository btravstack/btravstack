import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { ORY_ISSUER, provisionOry } from "./ory.js";

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
