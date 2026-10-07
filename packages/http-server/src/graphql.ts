import type { OneScheme, Requirements } from "@btravstack/contract";
import { Provider, type AnyPort } from "@btravstack/di";
import type { GraphQLSchema } from "graphql";
import { createYoga } from "graphql-yoga";
import { P } from "unthrown";

import { principalOf, resolveScheme, schemeDeps, schemeServices, type Resolved } from "./auth.js";
import type { Authenticators, Http } from "./define-http.js";
import { HttpHandler, send } from "./handler.js";
import { HttpConfig } from "./http-config.js";
import { HttpUnit } from "./http-runtime.js";
import type { RequiresGate } from "./orpc-gates.js";
import type { SchemePortsOf } from "./orpc.js";
import { forkUnit } from "./unit-scope.js";

/** Serve a GraphQL schema as one answerer under the existing HTTP runtime. */
export const graphql = <
  A extends Authenticators,
  const R extends Requirements & { readonly [I in keyof R]: OneScheme<R[I]> } = never,
>(
  api: Http<A>,
  options: {
    readonly schema: GraphQLSchema;
    readonly prefix?: `/${string}`;
    readonly unit?: Readonly<Record<string, AnyPort>>;
    readonly requires?: R & RequiresGate<R, { readonly [K in keyof A]: A[K]["scope"] }>;
  },
) => {
  const prefix = options.prefix ?? "/graphql";
  const requirements = options.requires as Requirements | undefined;
  const schemes = [
    ...new Set(requirements?.flatMap((requirement) => Object.keys(requirement)) ?? []),
  ];
  const provider = Provider.member(HttpHandler)({
    inject: { config: HttpConfig, units: HttpUnit, ...schemeDeps(schemes) },
    sync: (services) => {
      const config = services.config;
      const units = services.units;
      const authenticators = schemeServices(schemes, services);
      const yoga = createYoga<{
        principal: unknown;
        unit: Readonly<Record<string, unknown>>;
        signal: AbortSignal;
      }>({
        schema: options.schema,
        graphqlEndpoint: prefix,
        graphiql: false,
        landingPage: false,
        multipart: false,
        maxRequestBodySize: config.bodyLimit === 0 ? false : config.bodyLimit,
        disposeOnProcessTerminate: false,
      });
      return {
        prefix,
        handle: async (request, response, signal, host) => {
          let resolved: Resolved | undefined;
          if (requirements !== undefined) {
            const result = await resolveScheme(
              requirements,
              authenticators,
              request.headers,
            ).mapErrCases((matcher) =>
              matcher
                .with(P.tag("Unauthenticated"), () => 401 as const)
                .with(P.tag("UnderScoped"), () => 403 as const),
            );
            if (result.isDefect()) {
              // oxlint-disable-next-line unthrown/no-throw -- an authenticator defect belongs to the runtime's 500 path
              throw result.cause;
            }
            if (result.isErr()) {
              send(response, result.error);
              return;
            }
            resolved = result.value;
          }
          const forked = await forkUnit(host, units, api.principals, resolved, options.unit ?? {});
          if (forked.isDefect()) {
            // oxlint-disable-next-line unthrown/no-throw -- the handler has no defect channel
            throw forked.cause;
          }
          await yoga.handle(request, response, {
            principal:
              requirements === undefined ? undefined : principalOf(requirements, resolved!),
            unit: forked.get(),
            signal,
          });
        },
      };
    },
  });
  // `schemeDeps` is keyed at runtime, while the literal `R` carries the
  // precise port ids to di's needs gate. The two describe the same schemes.
  const typed = provider as Provider<
    InstanceType<typeof HttpHandler>,
    never,
    InstanceType<typeof HttpConfig> | InstanceType<typeof HttpUnit> | SchemePortsOf<R>
  >;
  return Object.assign(typed, { authenticators: api.providers });
};
