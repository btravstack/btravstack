import type { IncomingMessage } from "node:http";

import type { OneScheme, Requirements } from "@btravstack/contract";
import { Provider, type AnyPort, type Scope } from "@btravstack/di";
import {
  principalOf,
  resolveScheme,
  schemeDeps,
  schemeServices,
  type Resolved,
} from "@btravstack/http-server/internal";
import type { Authenticators, HttpAuth } from "@btravstack/http-server/internal";
import { HttpHandler, send, type HttpAnswerer } from "@btravstack/http-server/internal";
import { HttpConfig, HttpUnit } from "@btravstack/http-server/internal";
import type {
  KindOf,
  Kinds,
  RequiresGate,
  SchemePortsOf,
  UnitFor,
  UnitsNeedsOf,
  UnitsOf,
} from "@btravstack/http-server/internal";
import { forkUnit } from "@btravstack/http-server/internal";
import type { GraphQLSchema } from "graphql";
import { createYoga, type Plugin, type YogaServerOptions } from "graphql-yoga";
import { P } from "unthrown";

const dispose = Symbol("graphql.dispose");
type DisposableAnswerer = HttpAnswerer & { readonly [dispose]: () => Promise<void> | void };

type YogaCors = YogaServerOptions<Record<string, unknown>, Record<string, unknown>>["cors"];
type MissingUnitPorts<
  U extends Readonly<Record<string, AnyPort>>,
  Units,
  K extends string,
> = Exclude<keyof U, keyof UnitFor<U, Units, K>>;
type UnitGate<U extends Readonly<Record<string, AnyPort>>, Units, K extends string> = [
  MissingUnitPorts<U, Units, K>,
] extends [never]
  ? unknown
  : {
      readonly "UNIT PORT MISSING — the selected kind does not export": MissingUnitPorts<
        U,
        Units,
        K
      >;
    };

/** Serve a GraphQL schema as one answerer under the existing HTTP runtime. */
export type GraphqlOptions<
  A extends Authenticators,
  Units extends UnitsOf<A>,
  R extends Requirements & { readonly [I in keyof R]: OneScheme<R[I]> },
  U extends Readonly<Record<string, AnyPort>>,
> = {
  readonly schema: GraphQLSchema;
  readonly prefix?: `/${string}`;
  readonly cors?: YogaCors;
  readonly plugins?: readonly Plugin[];
  readonly units?: Units & { readonly [K in Exclude<keyof Units, Kinds<A>>]: never };
  readonly unit?: U & UnitGate<U, Units, KindOf<R>>;
  readonly requires?: R & RequiresGate<R, { readonly [K in keyof A]: A[K]["scope"] }>;
};

export const graphql = <
  A extends Authenticators,
  Units extends UnitsOf<A> = Record<never, never>,
  const R extends Requirements & { readonly [I in keyof R]: OneScheme<R[I]> } = never,
  U extends Readonly<Record<string, AnyPort>> = Record<never, never>,
>(
  api: HttpAuth<A>,
  options: GraphqlOptions<A, Units, R, U>,
) => {
  const mount = options.prefix ?? "/graphql";
  let end = mount.length;
  while (end > 1 && mount.charCodeAt(end - 1) === 47) end--;
  const prefix = mount.slice(0, end) as `/${string}`;
  const requirements = options.requires as Requirements | undefined;
  const schemes = [
    ...new Set(requirements?.flatMap((requirement) => Object.keys(requirement)) ?? []),
  ];
  const provider = Provider.member(HttpHandler)({
    inject: { config: HttpConfig, units: HttpUnit, ...schemeDeps(schemes) },
    sync: (services) => {
      const config = services.config;
      const units = services.units;
      if (options.units !== undefined)
        for (const kind of requirements === undefined ? ["anonymous"] : schemes) {
          const declared = options.units[kind] ?? options.units["anonymous"];
          const bound = units[kind] ?? units["anonymous"];
          if (declared !== bound)
            // oxlint-disable-next-line unthrown/no-throw -- a declaration that differs from the runtime's binding is a wiring defect
            throw new Error(
              `[graphql-server] unit kind ${JSON.stringify(kind)} differs from HttpUnit`,
            );
        }
      const authenticators = schemeServices(schemes, services);
      const yoga = createYoga<{
        principal: unknown;
        incoming: IncomingMessage;
        unit: Readonly<Record<string, unknown>>;
        signal: AbortSignal;
      }>({
        schema: options.schema,
        graphqlEndpoint: prefix,
        cors:
          options.cors ??
          (config.corsOrigin === ""
            ? false
            : { origin: config.corsOrigin.split(",").map((origin) => origin.trim()) }),
        plugins: options.plugins === undefined ? [] : [...options.plugins],
        logging: false,
        graphiql: false,
        landingPage: false,
        multipart: false,
        maxRequestBodySize: config.bodyLimit === 0 ? false : config.bodyLimit,
        disposeOnProcessTerminate: false,
      });
      return {
        prefix,
        handle: async (request, response, signal, host) => {
          if (
            request.method === "OPTIONS" &&
            request.headers["access-control-request-method"] !== undefined
          ) {
            await yoga.handle(request, response, {
              principal: undefined,
              incoming: request,
              unit: {},
              signal,
            });
            return;
          }
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
            incoming: request,
            unit: forked.get(),
            signal,
          });
        },
        [dispose]: () => yoga.dispose(),
      };
    },
    onStop: (answerer) => (answerer as DisposableAnswerer)[dispose](),
  });
  // `schemeDeps` is keyed at runtime, while the literal `R` carries the
  // precise port ids to di's needs gate. The two describe the same schemes.
  const typed = provider as Provider<
    InstanceType<typeof HttpHandler>,
    never,
    | InstanceType<typeof HttpConfig>
    | InstanceType<typeof HttpUnit>
    | UnitsNeedsOf<Units>
    | SchemePortsOf<R>
    | Scope
  >;
  return Object.assign(typed, { authenticators: api.providers });
};
