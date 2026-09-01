import { Port } from "@btravstack/di";
import { OkAsync } from "unthrown";
import { describe, expectTypeOf, test } from "vitest";

import { HttpAuthenticator } from "./auth.js";
import { defineHttp } from "./define-http.js";

describe("defineHttp", () => {
  test("infers the scheme registry from the authenticators", () => {
    const api = defineHttp({
      authenticators: {
        user: HttpAuthenticator<{ readonly userId: string }>()({
          inject: {},
          sync: () => () => OkAsync({ userId: "u-1" }),
        }),
        service: HttpAuthenticator<{ readonly appId: string }>()({
          inject: {},
          sync: () => () => OkAsync({ appId: "a-1" }),
        }),
      },
    });
    expectTypeOf(api.authenticators.user.principal).toEqualTypeOf<{ readonly userId: string }>();
    expectTypeOf(api.authenticators.service.principal).toEqualTypeOf<{ readonly appId: string }>();
  });

  test("an application with no auth needs no argument", () => {
    const api = defineHttp();
    expectTypeOf(api.authenticators).toEqualTypeOf<Record<never, never>>();
  });

  test("an authenticator's own dependencies ride through to the graph", () => {
    class Verifier extends Port("DefineVerifier")<(token: string) => { readonly userId: string }> {}
    const api = defineHttp({
      authenticators: {
        user: HttpAuthenticator<{ readonly userId: string }>()({
          inject: { verify: Verifier },
          sync:
            ({ verify }) =>
            (headers) =>
              OkAsync(verify(headers.authorization ?? "")),
        }),
      },
    });
    expectTypeOf(api.authenticators.user.needs).toEqualTypeOf<Verifier>();
  });
});
