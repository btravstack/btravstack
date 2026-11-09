import type { ConfigSchema } from "@btravstack/config";
import { Port, type ServiceOf } from "@btravstack/di";
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
