import SchemaBuilder, { BasePlugin, type SchemaTypes } from "@pothos/core";

import { defineProcedureFields } from "./procedure-field.js";

const pluginName = "orpc";

class PothosOrpcPlugin<Types extends SchemaTypes> extends BasePlugin<Types> {}

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
