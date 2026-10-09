import { Port, Provider } from "@btravstack/di";
import { describe, test } from "vitest";

import {
  Config,
  type ConfigSchema,
  type Env,
  type EnvReading,
  type Environment,
  type EnvironmentFor,
} from "./index.js";

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

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type NeedsOf<T> = T extends Provider<infer _P, infer _E, infer N> ? N : never;

declare const maybeKeys: readonly string[] | undefined;

describe("a field names its variable, and a provider's needs carry the names", () => {
  const schema = Config.object({
    url: Config.string("DATABASE_URL"),
    poolSize: Config.integer("DATABASE_POOL_SIZE", { min: 1, default: 8 }),
    keys: Config.pinned(maybeKeys, Config.list("SESSION_KEYS")),
    port: Config.pinned(3000, Config.port("PORT")),
  });

  test("required without a default, optional with one or a maybe-pin, absent when certainly pinned", () => {
    const provider = Config.provider("DatabaseConfig")(schema);
    const named: Equal<
      NeedsOf<typeof provider>,
      EnvReading<"DATABASE_URL", "DATABASE_POOL_SIZE" | "SESSION_KEYS">
    > = true;
    void named;
  });

  test("the environment a graph accepts: required keys, optional keys, nothing else", () => {
    type Accepted = EnvironmentFor<EnvReading<"DATABASE_URL", "DATABASE_POOL_SIZE">>;
    const ok: Accepted = { DATABASE_URL: "postgres://db" };
    // @ts-expect-error DATABASE_URL is required: nothing defaults or pins it
    const missing: Accepted = { DATABASE_POOL_SIZE: "4" };
    // @ts-expect-error a misspelt variable is not one any reader names
    const misspelt: Accepted = { DATABASE_URL: "postgres://db", DATABSE_POOL_SIZE: "4" };
    void [ok, missing, misspelt];
  });

  test("a reader that names nothing opens the environment again", () => {
    const accepted: Equal<
      EnvironmentFor<EnvReading<"DATABASE_URL", never> | Env>,
      Environment
    > = true;
    void accepted;
  });

  test("Config.env injects Env typed by what the schema reads", () => {
    const provider = Provider(Port("ConfigEnvProbe")<string>)({
      inject: { env: Config.env(schema) },
      sync: ({ env }) => env["DATABASE_URL"] ?? "",
    });
    const named: Equal<
      NeedsOf<typeof provider>,
      EnvReading<"DATABASE_URL", "DATABASE_POOL_SIZE" | "SESSION_KEYS">
    > = true;
    void named;
  });
});
