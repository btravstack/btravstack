import { Module, Port, Provider, type ServiceOf } from "@btravstack/di";
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

// ── Unit kinds: the two-step breaks the cycle ────────────────────────────────

class Span extends Port("DefineSpan")<{ readonly finish: () => void }> {}
class Tenant extends Port("DefineTenant")<string> {}

const userAuth = HttpAuthenticator<{ readonly tenantId: string }>()({
  inject: {},
  sync: () => () => OkAsync({ tenantId: "t-1" }),
});

const withUser = defineHttp({ authenticators: { user: userAuth } });

// `typeof withUser` depends on the authenticators alone, so a module may
// name a principal in `needs` without a cycle.
const Anonymous = Module("DefineAnonymous")({
  provides: [Provider(Span)({ inject: {}, sync: () => ({ finish: () => undefined }) })],
  exports: [Span],
});
const User = Module("DefineUser")({
  needs: [withUser.principals.user],
  imports: [Anonymous],
  provides: [
    Provider(Tenant)({
      inject: { principal: withUser.principals.user },
      sync: ({ principal }) => principal.tenantId,
    }),
  ],
  exports: [Tenant, Anonymous],
});

const kinded = withUser.units<{ anonymous: typeof Anonymous; user: typeof User }>();

// The principal port carries the identity the authenticator declared.
const _principalTyped: ServiceOf<InstanceType<typeof withUser.principals.user>> extends {
  readonly tenantId: string;
}
  ? true
  : never = true;

// Retyping keeps every factory; nothing is rebuilt.
const _sameFactories: typeof kinded.OrpcController extends typeof withUser.OrpcController
  ? true
  : never = true;

// A kind the authenticators do not declare is refused.
// @ts-expect-error — "service" is not a scheme of these authenticators
withUser.units<{ service: typeof User }>();

// A non-module under a kind is refused.
// @ts-expect-error — a kind binds a Module, not a port
withUser.units<{ anonymous: typeof Span }>();

// `defineHttp()` with no authenticators has `anonymous` as its only kind.
const bare = defineHttp();
bare.units<{ anonymous: typeof Anonymous }>();
// @ts-expect-error — no scheme named "user" on a bare defineHttp
bare.units<{ user: typeof User }>();
