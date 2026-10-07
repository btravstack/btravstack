import { Port } from "@btravstack/di";
import { describe, test } from "vitest";

import { Config, type ConfigSchema, type Environment } from "./index.js";

class Tags extends Port("ConfigTags")<readonly string[]> {}
class Hooks extends Port.many("ConfigHooks")<string> {}

declare const tags: ConfigSchema<Environment, readonly string[]>;

describe("Config.provider on a declared port", () => {
  test("an ordinary port whose service is an array is bound", () => {
    Config.provider(Tags)(tags);
  });

  test("a set port is refused, naming Provider.member", () => {
    // @ts-expect-error SET PORT — contribute one member with Provider.member
    Config.provider(Hooks)(tags);
  });
});
