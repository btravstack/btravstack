import type { ConfigSchema, EnvironmentFor, EnvReading } from "@btravstack/config";
import { Port, type Provider, type ServiceOf } from "@btravstack/di";
import { Ok, OkAsync } from "unthrown";
import { expectTypeOf } from "vitest";

import { oidc, type OidcLoginContext, type OidcOptions } from "./oidc.js";

type Context = { readonly tenant: string };
class Tenants extends Port("LoginTenants")<readonly string[]> {}
declare const schema: ConfigSchema<unknown, Context>;

const [contextual] = oidc<Context, Context>()({
  inject: { tenants: Tenants },
  loginContext: {
    schema,
    resolve: (request, { tenants }) => {
      expectTypeOf(request.signal).toEqualTypeOf<AbortSignal>();
      expectTypeOf(tenants).toEqualTypeOf<ServiceOf<Tenants>>();
      return OkAsync({ tenant: request.url });
    },
    allowedParameters: ["login_hint"],
    authorizationParameters: (context, { tenants }) => {
      expectTypeOf(context).toEqualTypeOf<Context>();
      expectTypeOf(tenants).toEqualTypeOf<ServiceOf<Tenants>>();
      return { login_hint: context.tenant };
    },
  },
  principal: (_claims, { tenants }, context) => {
    expectTypeOf(context).toEqualTypeOf<Context>();
    expectTypeOf(tenants).toEqualTypeOf<ServiceOf<Tenants>>();
    return context;
  },
});

// @ts-expect-error a required context cannot be promised without its resolver and schema
const [missing] = oidc<Context, Context>()({ principal: (_claims, _services, context) => context });

const [legacy] = oidc()({
  principal: (claims, _services, context) => {
    expectTypeOf(context).toEqualTypeOf<undefined>();
    return claims;
  },
});

const options: OidcOptions<Context, string, Record<never, never>, Context> = {
  loginContext: { schema, resolve: () => Ok({ tenant: "example" }) },
  principal: (_claims, _services, context) => context,
};
const policy: OidcLoginContext<Context> = options.loginContext!;
const bad: OidcLoginContext<Context> = {
  schema,
  resolve: () => Ok({}),
  // @ts-expect-error principal context retains its schema output type
  authorizationParameters: (context: number) => ({ login_hint: String(context) }),
};

const [explicitlyContextFree] = oidc<unknown, undefined>()({
  principal: (claims, _services, context) => {
    expectTypeOf(context).toEqualTypeOf<undefined>();
    return claims;
  },
});

// @ts-expect-error an explicit context union still requires resolution and validation
const [missingOptional] = oidc<unknown, Context | undefined>()({ principal: (claims) => claims });

// @ts-expect-error unknown is an explicit context contract, not the context-free default
const [missingUnknown] = oidc<unknown, unknown>()({ principal: (claims) => claims });

// @ts-expect-error an impossible context must not be manufactured by omitting its resolver
const [missingNever] = oidc<unknown, never>()({ principal: (claims) => claims });

type DynamicContext = ReturnType<typeof JSON.parse>;
// @ts-expect-error a dynamically typed context still requires resolution and validation
const [missingDynamic] = oidc<unknown, DynamicContext>()({ principal: (claims) => claims });

const [optionalContext] = oidc<unknown, Context | undefined>()({
  loginContext: { schema, resolve: () => Ok({ tenant: "example" }) },
  principal: (_claims, _services, context) => {
    expectTypeOf(context).toEqualTypeOf<Context | undefined>();
    return context;
  },
});

const [unknownContext] = oidc<unknown, unknown>()({
  loginContext: { schema, resolve: () => Ok({ tenant: "example" }) },
  principal: (_claims, _services, context) => {
    expectTypeOf(context).toEqualTypeOf<unknown>();
    return context;
  },
});

const pins = { issuer: "https://issuer.example", clientId: "app", clientSecret: "secret" };

const [derived] = oidc<Context, Context>()({
  ...pins,
  inject: { tenants: Tenants },
  loginContext: {
    schema,
    resolve: () => Ok({ tenant: "acme" }),
    redirectUri: (context, { tenants }) => {
      expectTypeOf(context).toEqualTypeOf<Context>();
      expectTypeOf(tenants).toEqualTypeOf<ServiceOf<Tenants>>();
      return `https://${context.tenant}.app.example/auth/callback`;
    },
    postLogoutRedirectUri: (context, { tenants }) => {
      expectTypeOf(context).toEqualTypeOf<Context>();
      expectTypeOf(tenants).toEqualTypeOf<ServiceOf<Tenants>>();
      return `https://${context.tenant}.app.example/signed-out`;
    },
  },
  principal: (_claims, _services, context) => context,
});
const [staticRedirect] = oidc<Context, Context>()({
  ...pins,
  loginContext: { schema, resolve: () => Ok({ tenant: "acme" }) },
  principal: (_claims, _services, context) => context,
});
const [annotatedRedirect] = oidc<Context, Context>()({
  ...pins,
  loginContext: policy,
  principal: (_claims, _services, context) => context,
});
expectTypeOf<EnvironmentFor<NeedsOf<typeof derived>>>().toEqualTypeOf<
  EnvironmentFor<EnvReading<never, "HTTP_OIDC_POST_LOGOUT_REDIRECT_URI">>
>();
expectTypeOf<EnvironmentFor<NeedsOf<typeof staticRedirect>>>().toEqualTypeOf<
  EnvironmentFor<EnvReading<"HTTP_OIDC_REDIRECT_URI", "HTTP_OIDC_POST_LOGOUT_REDIRECT_URI">>
>();
expectTypeOf<EnvironmentFor<NeedsOf<typeof annotatedRedirect>>>().toEqualTypeOf<
  EnvironmentFor<EnvReading<never, "HTTP_OIDC_REDIRECT_URI" | "HTTP_OIDC_POST_LOGOUT_REDIRECT_URI">>
>();

const wrongRedirect: OidcLoginContext<Context> = {
  schema,
  resolve: () => Ok({}),
  // @ts-expect-error a derived redirect URI reads the schema's output type
  redirectUri: (context: number) => String(context),
};

const nonString: OidcLoginContext<Context> = {
  schema,
  resolve: () => Ok({}),
  // @ts-expect-error a derived post-logout URI is an absolute URI string
  postLogoutRedirectUri: () => new URL("https://acme.app.example/signed-out"),
};

type NeedsOf<T> = T extends Provider<infer _P, infer _E, infer N> ? N : never;
