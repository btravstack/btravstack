import type { IncomingMessage } from "node:http";

import { Config, Env, type ConfigInvalid, type EnvReading } from "@btravstack/config";
import type { OneScheme, Requirements } from "@btravstack/contract";
import { Observers, observe } from "@btravstack/core";
import { Provider, type AnyPort, type Scope } from "@btravstack/di";
import {
  principalOf,
  resolveScheme,
  schemeDeps,
  schemeServices,
  type Resolved,
} from "@btravstack/http-server/internal";
import type { Authenticators, HttpAuth } from "@btravstack/http-server/internal";
import { HttpHandler, type HttpAnswerer } from "@btravstack/http-server/internal";
import { HttpConfig, HttpUnit } from "@btravstack/http-server/internal";
import type {
  KindOf,
  Kinds,
  Principal,
  RequiresGate,
  SchemesFrom,
  SchemesOf,
  SchemePortsOf,
  UnitFor,
  UnitsNeedsOf,
  UnitsOf,
} from "@btravstack/http-server/internal";
import { forkUnit } from "@btravstack/http-server/internal";
import type { GraphQLSchema, ValidationRule } from "graphql";
import {
  createGraphQLError,
  createYoga,
  maskError,
  type Plugin,
  type YogaInitialContext,
  type YogaServerOptions,
} from "graphql-yoga";
import { P } from "unthrown";

const dispose = Symbol("graphql.dispose");

/** What failed: GraphQL locates a resolver's error by wrapping it, and a log line walks `cause`, not `originalError`. */
const causeOf = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "originalError" in error && error.originalError
    ? error.originalError
    : error;

const pathOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "path" in error && Array.isArray(error.path)
    ? error.path.join(".")
    : undefined;
/**
 * Refuses `__schema` and `__type` by field name alone. graphql's own
 * `NoSchemaIntrospectionCustomRule` asserts the schema's class, which throws
 * when the application and Yoga load two copies of `graphql`.
 */
const noIntrospection: ValidationRule = (context) => ({
  Field: (node) => {
    if (node.name.value === "__schema" || node.name.value === "__type")
      context.reportError(
        createGraphQLError(
          `GraphQL introspection is not allowed, but the query contained ${node.name.value}`,
          { nodes: [node] },
        ),
      );
  },
});

const withoutIntrospection: Plugin = {
  onValidate: ({ addValidationRule }) => addValidationRule(noIntrospection),
};

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

/**
 * The context `graphql()` hands Yoga for an operation: what a resolver and a
 * plugin's operation hooks (`onParse`, `onValidate`, `onContextBuilding`,
 * `onExecute`, `onSubscribe`) read beside Yoga's own `request`. `principal` is
 * the caller `requires` resolved, `undefined` without `requires`; `unit` is the
 * `unit` record read off the forked kind; `incoming` is the Node request.
 *
 * Those hooks run only once the caller is authenticated. A preflight and a
 * refusal end in Yoga's server hooks (`onRequest`, `onResponse`), whose
 * context is not this type, so a plugin cannot claim a principal there.
 */
export type GraphqlContext<Principal = unknown, Unit = Readonly<Record<string, unknown>>> = {
  readonly principal: Principal;
  readonly incoming: IncomingMessage;
  readonly unit: Unit;
  readonly signal: AbortSignal;
};

/** The {@link GraphqlContext} one `graphql()` call builds, from its own options. */
type ContextOf<
  A extends Authenticators,
  Units,
  R extends Requirements,
  U extends Readonly<Record<string, AnyPort>>,
> = GraphqlContext<
  [R] extends [never] ? undefined : Principal<SchemesOf<R>, SchemesFrom<A>>,
  UnitFor<U, Units, KindOf<R>>
>;

/**
 * Each plugin, unless the context this call builds lacks something it reads, or
 * the entry is not a plugin at all.
 * Per element, because Yoga's `Plugin<C>` is invariant in `C`: a plugin typed
 * for the real context is not a `Plugin`, so none could be widened to one.
 */
type PluginsGate<PS extends readonly unknown[], C> = {
  readonly [I in keyof PS]: PS[I] extends Plugin<infer X>
    ? YogaInitialContext & C extends X
      ? PS[I]
      : "PLUGIN CONTEXT MISMATCH — this plugin reads what this graphql() call does not put in its context"
    : { readonly "NOT A PLUGIN — this entry is not a Yoga plugin": PS[I] };
};

/** Serve a GraphQL schema as one answerer under the existing HTTP runtime. */
export type GraphqlOptions<
  A extends Authenticators,
  Units extends UnitsOf<A>,
  R extends Requirements & { readonly [I in keyof R]: OneScheme<R[I]> },
  U extends Readonly<Record<string, AnyPort>>,
  PS extends readonly unknown[] = readonly Plugin[],
> = {
  readonly schema: GraphQLSchema;
  readonly prefix?: `/${string}`;
  readonly cors?: YogaCors;
  /**
   * GraphiQL and introspection, both or neither — pins
   * `GRAPHQL_DEVELOPER_TOOLS`, which defaults to `false`, so a deployment
   * exposes neither unless it says so.
   */
  readonly developerTools?: boolean;
  /**
   * Yoga plugins. Each may be typed by the context it reads — a
   * `Plugin<{ unit: … }>` — and is checked against the {@link GraphqlContext}
   * this call builds.
   */
  readonly plugins?:
    | (PS & PluginsGate<PS, ContextOf<A, Units, R, U>>)
    | readonly Plugin<YogaInitialContext & ContextOf<A, Units, R, U>>[];
  readonly units?: Units & { readonly [K in Exclude<keyof Units, Kinds<A>>]: never };
  readonly unit?: U & UnitGate<U, Units, KindOf<R>>;
  readonly requires?: R & RequiresGate<R, { readonly [K in keyof A]: A[K]["scope"] }>;
};

export const graphql = <
  A extends Authenticators,
  Units extends UnitsOf<A> = Record<never, never>,
  const R extends Requirements & { readonly [I in keyof R]: OneScheme<R[I]> } = never,
  U extends Readonly<Record<string, AnyPort>> = Record<never, never>,
  const PS extends readonly unknown[] = [],
>(
  api: HttpAuth<A>,
  options: GraphqlOptions<A, Units, R, U, PS>,
) => {
  const mount = options.prefix ?? "/graphql";
  let end = mount.length;
  while (end > 1 && mount.charCodeAt(end - 1) === 47) end--;
  const prefix = mount.slice(0, end) as `/${string}`;
  const requirements = options.requires as Requirements | undefined;
  const schemes = [
    ...new Set(requirements?.flatMap((requirement) => Object.keys(requirement)) ?? []),
  ];
  const developerToolsSchema = Config.object({
    developerTools: Config.pinned(
      options.developerTools,
      Config.boolean("GRAPHQL_DEVELOPER_TOOLS", { default: false }),
    ),
  });
  const provider = Provider.member(HttpHandler)({
    inject: {
      env: Env,
      config: HttpConfig,
      units: HttpUnit,
      observers: Observers,
      ...schemeDeps(schemes),
    },
    make: (services) =>
      Config.parse(
        "GraphqlConfig",
        developerToolsSchema,
      )(services.env).map(({ developerTools }) => {
        const config = services.config;
        const units = services.units;
        const observers = services.observers;
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
        const refuse: Plugin<{}, { refusalStatus?: 401 | 403 }> = {
          onRequest: ({ serverContext, fetchAPI, endResponse }) => {
            if (serverContext.refusalStatus !== undefined)
              endResponse(new fetchAPI.Response(null, { status: serverContext.refusalStatus }));
          },
        };
        const yoga = createYoga<{
          principal: unknown;
          incoming: IncomingMessage;
          unit: Readonly<Record<string, unknown>>;
          signal: AbortSignal;
          refusalStatus?: 401 | 403;
        }>({
          schema: options.schema,
          graphqlEndpoint: prefix,
          cors:
            options.cors ??
            (config.corsOrigin === ""
              ? false
              : { origin: config.corsOrigin.split(",").map((origin) => origin.trim()) }),
          plugins: [
            refuse,
            ...(developerTools ? [] : [withoutIntrospection]),
            ...((options.plugins ?? []) as readonly Plugin[]),
          ],
          // Yoga reports what it masks through its logger, which is off: the
          // defect is reported to `Observers` here instead, or nowhere.
          maskedErrors: {
            maskError: (error, message, isDev) => {
              const masked = maskError(error, message, isDev);
              if (masked !== error)
                observe(observers, {
                  component: "graphql",
                  name: "defect",
                  attributes: {},
                  details: { "graphql.path": pathOf(error) },
                  traced: false,
                })({ outcome: "error", cause: causeOf(error) });
              return masked;
            },
          },
          logging: false,
          graphiql: developerTools,
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
                await yoga.handle(request, response, {
                  principal: undefined,
                  incoming: request,
                  unit: {},
                  signal,
                  refusalStatus: result.error,
                });
                return;
              }
              resolved = result.value;
            }
            const forked = await forkUnit(
              host,
              units,
              api.principals,
              resolved,
              options.unit ?? {},
            );
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
      }),
    onStop: (answerer) => (answerer as DisposableAnswerer)[dispose](),
  });
  // `schemeDeps` is keyed at runtime, while the literal `R` carries the
  // precise port ids to di's needs gate. The two describe the same schemes.
  const typed = provider as Provider<
    InstanceType<typeof HttpHandler>,
    ConfigInvalid,
    | EnvReading<never, "GRAPHQL_DEVELOPER_TOOLS">
    | InstanceType<typeof HttpConfig>
    | InstanceType<typeof HttpUnit>
    | Observers
    | UnitsNeedsOf<Units>
    | SchemePortsOf<R>
    | Scope
  >;
  return Object.assign(typed, { authenticators: api.providers });
};
