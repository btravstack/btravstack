import { authenticated } from "@btravstack/contract";
import { Observers, type Settled } from "@btravstack/core";
import { Provider } from "@btravstack/di";
import { html } from "@btravstack/htmx-server";
import {
  AuthenticatorUnavailable,
  HttpAuthenticator,
  resolvePrincipal,
} from "@btravstack/http-server";
import { oc } from "@orpc/contract";
import { openapi } from "@orpc/openapi";
import { ErrAsync, OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { defineHttp } from "./define-http.js";
import { HttpModule } from "./http-module.js";

describe("an unavailable authenticator", () => {
  it.for(["/rpc/check", "/api/check", "/fragments/check"])(
    "answers 503 at %s and reports the scheme",
    async (path, { boot }) => {
      // GIVEN a protected procedure whose identity dependency is unavailable
      const observations: { scheme: unknown; settled: Settled }[] = [];
      const api = defineHttp({
        authenticators: {
          user: HttpAuthenticator<{}>()({
            inject: {},
            sync: () => () => ErrAsync(new AuthenticatorUnavailable()),
          }),
        },
      });
      const contract = {
        check: authenticated({ user: [] })(oc.meta(openapi({ method: "POST", path: "/check" }))),
      };
      const router = api.OrpcRouter(contract)({
        sync: () => ({ check: () => OkAsync(undefined) }),
      });
      const info = (
        await boot(
          HttpModule("UnavailableAuth")({
            router,
            fragments: api.HtmxFragments([
              api.HtmxGet("/check", { requires: [{ user: [] }] })({
                sync: () => () => OkAsync(html`never`),
              }),
            ]),
            fragmentsPrefix: "/fragments",
            fragmentsLogin: "/login",
            port: 0,
            hostname: "127.0.0.1",
            openapi: true,
            provides: [
              Provider.member(Observers)({
                inject: {},
                value: (operation) => (settled) => {
                  if (operation.component === "auth")
                    observations.push({ scheme: operation.attributes["scheme"], settled });
                },
              }),
            ],
          }),
        ).runtimeInfo()
      ).get();

      // WHEN the protected endpoint is called
      const response = await fetch(`http://127.0.0.1:${info?.port}${path}`, {
        method: path.startsWith("/fragments") ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        ...(path.startsWith("/fragments")
          ? {}
          : { body: path.startsWith("/rpc") ? '{"json":{}}' : "{}" }),
      });

      // THEN dependency failure is distinct from bad credentials and is observed
      expect({ status: response.status, observations }).toEqual({
        status: 503,
        observations: [
          {
            scheme: "user",
            settled: {
              outcome: "error",
              cause: expect.objectContaining({ _tag: "AuthenticatorUnavailable" }),
            },
          },
        ],
      });
    },
  );
  it("does not try a later scheme after an outage", async () => {
    // GIVEN a second scheme that would grant access
    let fallbackCalls = 0;
    // WHEN the first verifier cannot decide
    const result = await resolvePrincipal(
      [{ user: [] }, { service: [] }],
      {
        user: () => ErrAsync(new AuthenticatorUnavailable()),
        service: () => {
          fallbackCalls += 1;
          return OkAsync({});
        },
      },
      {},
    );
    // THEN the outage is terminal and no identity is promoted
    expect({ tag: result.isErr() ? result.error._tag : result.tag, fallbackCalls }).toEqual({
      tag: "AuthenticatorUnavailable",
      fallbackCalls: 0,
    });
  });
});
