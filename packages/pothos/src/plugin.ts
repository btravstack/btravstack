import SchemaBuilder, { BasePlugin, type SchemaTypes } from "@pothos/core";
import type { GraphQLFieldResolver } from "graphql";
import { fromSafePromise } from "unthrown";

import { accessRefusal } from "./access-refusal.js";
import { defineProcedureFields } from "./procedure-field.js";

const pluginName = "orpc";

class PothosOrpcPlugin<Types extends SchemaTypes> extends BasePlugin<Types> {
  public override wrapArgMappers(
    resolve: GraphQLFieldResolver<unknown, Types["Context"], object>,
  ): GraphQLFieldResolver<unknown, Types["Context"], object> {
    return (parent, args, context, info) =>
      fromSafePromise(Promise.resolve(resolve(parent, args, context, info)))
        .recoverDefect<never, never>((cause) => {
          // oxlint-disable-next-line unthrown/no-throw -- outside Result and error-union settlement, only our sanitized access marker is public
          throw accessRefusal(cause) ?? cause;
        })
        .get();
  }
}

declare global {
  export namespace PothosSchemaTypes {
    // oxlint-disable-next-line typescript/consistent-type-definitions -- a module augmentation must be an interface; a type alias cannot merge
    export interface Plugins<Types extends SchemaTypes> {
      orpc: PothosOrpcPlugin<Types>;
    }
  }
}

SchemaBuilder.registerPlugin(pluginName, PothosOrpcPlugin);
defineProcedureFields();

export default pluginName;
