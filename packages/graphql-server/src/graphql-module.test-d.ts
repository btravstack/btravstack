import { HealthChecks, Logger, start } from "@btravstack/core";
import { Module, Port, Provider, type Context } from "@btravstack/di";
import { defineAuth } from "@btravstack/http-server";
import type { GraphQLSchema } from "graphql";
import { OkAsync } from "unthrown";

import { GraphqlModule } from "./graphql-module.js";
import { graphql } from "./graphql.js";

const schema = null as unknown as GraphQLSchema;
const bare = GraphqlModule("BareGraphql")({ answerer: graphql(defineAuth(), { schema }) });
void start(bare);
type Exports<M> = M extends Module<infer X, infer _E, infer _N> ? X : never;
declare const bareContext: Context<Exports<typeof bare>>;
// @ts-expect-error -- an application without a logger does not expose one
bareContext.get(Logger);
const Business = Port("GraphqlModuleBusiness")<string>;
const infrastructure = Module("GraphqlModuleInfrastructure")({
  provides: [
    Provider(Logger)({ inject: {}, sync: () => null as never }),
    Provider(Business)({ inject: {}, value: "business" }),
    Provider.member(HealthChecks)({
      inject: {},
      value: { name: "backend", timeoutMs: 100, check: () => OkAsync() },
    }),
  ],
  exports: [Logger, HealthChecks, Business],
});
const root = GraphqlModule("InfrastructureGraphql")({
  answerer: graphql(defineAuth(), { schema }),
  imports: [infrastructure],
});
declare const context: Context<Exports<typeof root>>;
context.get(Logger);
context.get(HealthChecks);
// @ts-expect-error -- business exports remain explicit at the application root
context.get(Business);
const exposed = GraphqlModule("ExposedGraphql")({
  answerer: graphql(defineAuth(), { schema }),
  imports: [infrastructure],
  exports: [Business],
});
declare const exposedContext: Context<Exports<typeof exposed>>;
exposedContext.get(Business);
const dependent = Provider(Business)({ inject: { logger: Logger }, sync: () => "business" });
// @ts-expect-error -- UNDECLARED NEEDS: the application's own provider needs a logger
GraphqlModule("MissingGraphqlLogger")({
  answerer: graphql(defineAuth(), { schema }),
  provides: [dependent],
});
const unfinished = GraphqlModule("NeedsGraphqlLogger")({
  answerer: graphql(defineAuth(), { schema }),
  provides: [dependent],
  needs: [Logger],
});
// @ts-expect-error -- UNSATISFIED DEPENDENCIES: declaring a logger need does not provide it
void start(unfinished);
