import { Env } from "@btravstack/config";
import { Module, Provider } from "@btravstack/di";
import { oauthClient, TokenSource } from "@btravstack/oauth-client";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { httpClientFetch } from "./index.js";

describe("OAuth policy boundary", () => {
  it.for([false, true])(
    "uses approved HTTPS for discovery and refuses metadata origin expansion %s",
    async (foreign, { network }) => {
      // GIVEN
      network.respond = (req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(
            req.url!.includes(".well-known")
              ? {
                  issuer: network.origin,
                  token_endpoint: foreign
                    ? "https://unapproved.example/token"
                    : network.origin + "/token",
                }
              : { access_token: "issued", token_type: "Bearer", expires_in: 3600 },
          ),
        );
      };
      const root = Module("Tokens")({
        imports: [
          oauthClient({
            issuer: network.origin,
            clientId: "client",
            clientSecret: "secret",
            fetch: httpClientFetch(network.client()),
          }),
        ],
        provides: [Provider(Env)({ inject: {}, value: {} })],
        exports: [TokenSource],
      });
      // WHEN
      const result = await Module.scoped(root, (ctx) =>
        ctx.get(TokenSource).token({ audience: "orders" }),
      );
      // THEN
      expect({
        tag: result.isOk() ? "Ok" : result.isErr() ? result.error._tag : "Defect",
        paths: network.requests.map(({ url, authorization }) => ({
          url,
          credential: authorization !== undefined,
        })),
      }).toEqual(
        foreign
          ? {
              tag: "TokenIssuerUnavailable",
              paths: [{ url: "/.well-known/openid-configuration", credential: false }],
            }
          : {
              tag: "Ok",
              paths: [
                { url: "/.well-known/openid-configuration", credential: false },
                { url: "/token", credential: true },
              ],
            },
      );
    },
  );
});
