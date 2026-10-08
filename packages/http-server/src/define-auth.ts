import { Provider, type AnyProvider, type PortClassOf, type PortInstance } from "@btravstack/di";

import {
  authenticatorPort,
  principalPort,
  type Authenticator,
  type AuthenticatorService,
} from "./auth.js";
import { cookieScheme } from "./cookie.js";
import { HttpSchemes } from "./unit-scope.js";

/** The authenticators an application declares, keyed by scheme name. */
export type Authenticators = Readonly<
  Record<string, Authenticator<unknown, string, unknown, unknown>>
>;

export type SchemesFrom<A extends Authenticators> = { readonly [K in keyof A]: A[K]["principal"] };
export type VocabFrom<A extends Authenticators> = { readonly [K in keyof A]: A[K]["scope"] };

export type SchemeProviders<A extends Authenticators> = {
  readonly [K in keyof A]: Provider<
    PortInstance<`HttpAuthenticator:${K & string}`, AuthenticatorService<unknown>>,
    A[K]["error"],
    A[K]["needs"]
  >;
}[keyof A];

export type Principals<A extends Authenticators> = {
  readonly [K in keyof A & string]: PortClassOf<`HttpPrincipal:${K}`, A[K]["principal"]>;
};

/** Shared authentication registry consumed by any HTTP answerer. */
export type HttpAuth<A extends Authenticators> = {
  readonly authenticators: A;
  readonly providers: readonly SchemeProviders<A>[];
  readonly principals: Principals<A>;
};

export const defineAuth = <const A extends Authenticators = Record<never, never>>(options?: {
  readonly authenticators: A;
}): HttpAuth<A> => {
  const declared: Authenticators = options?.authenticators ?? {};
  const providers = [
    ...Object.entries(declared).flatMap(([scheme, authenticator]) => [
      Provider(authenticatorPort(scheme) as never)(authenticator.options as never),
      ...(authenticator.cookie === true ? [cookieScheme()] : []),
    ]),
    Provider.member(HttpSchemes)({ inject: {}, value: Object.keys(declared) }),
  ] satisfies AnyProvider[];
  const principals = Object.fromEntries(
    Object.keys(declared).map((scheme) => [scheme, principalPort(scheme)]),
  );
  return {
    authenticators: declared as A,
    providers: providers as never,
    principals: principals as Principals<A>,
  };
};
