import { Module, Port, Provider, type ServiceOf } from "@btravstack/di";
import { OkAsync, type AsyncResult } from "unthrown";
import { test } from "vitest";

import { Config, Env, type ConfigInvalid, type ConfigSchema, type Environment } from "../config.js";

class Settings extends Port("ConfigFixtureSettings")<{
  readonly port: number;
  readonly host: string;
  readonly retries: number;
}> {}

class Named extends Port("ConfigFixtureNamed")<{ readonly name: string }> {}

/** The slice of environment the fixtures bind onto `Settings`. */
export const settingsSchema = Config.object({
  port: Config.port("PORT", { default: 3000 }),
  host: Config.string("HOST", { default: "0.0.0.0" }),
  retries: Config.integer("RETRIES", { min: 0, max: 10, default: 3 }),
});

/**
 * Build a graph the way the kernel does — `Env` provided as a value — with
 * one port bound through `Config.provider`, and resolve that port out of it.
 */
const settingsFrom = (env: Environment): AsyncResult<ServiceOf<Settings>, ConfigInvalid> =>
  Module.scoped(
    Module("ConfigFixture")({
      provides: [
        Provider(Env)({ inject: {}, value: env }),
        Config.provider(Settings)(settingsSchema),
      ],
      exports: [Settings],
    }),
    (ctx) => OkAsync(ctx.get(Settings)),
  );

const namedThrough = (
  schema: ConfigSchema<Environment, ServiceOf<Named>>,
  env: Environment,
): AsyncResult<ServiceOf<Named>, ConfigInvalid> =>
  Module.scoped(
    Module("ConfigFixture")({
      provides: [Provider(Env)({ inject: {}, value: env }), Config.provider(Named)(schema)],
      exports: [Named],
    }),
    (ctx) => OkAsync(ctx.get(Named)),
  );

/** The name form: the port is minted by `Config.provider`, and read back through the provider it returns. */
const minted = Config.provider("ConfigFixtureMinted")(
  Config.object({ retries: Config.integer("RETRIES", { min: 0, max: 10, default: 3 }) }),
);

const mintedFrom = (env: Environment): AsyncResult<{ readonly retries: number }, ConfigInvalid> =>
  Module.scoped(
    Module("ConfigFixture")({
      provides: [Provider(Env)({ inject: {}, value: env }), minted],
      exports: [minted.port],
    }),
    (ctx) => OkAsync(ctx.get(minted.port)),
  );

export type ConfigFixtures = {
  /** `Settings` bound from `env` through `settingsSchema`, resolved out of a built graph. */
  readonly bound: (env: Environment) => AsyncResult<
    {
      readonly port: number;
      readonly host: string;
      readonly retries: number;
    },
    ConfigInvalid
  >;
  /** A port `Config.provider("…")(schema)` minted, bound from `env`, resolved through `provider.port`. */
  readonly mintedFrom: (
    env: Environment,
  ) => AsyncResult<{ readonly retries: number }, ConfigInvalid>;
  /** `Named` bound from `env` through any Standard Schema over the environment. */
  readonly boundThrough: (
    schema: ConfigSchema<Environment, { readonly name: string }>,
    env: Environment,
  ) => AsyncResult<{ readonly name: string }, ConfigInvalid>;
};

export const it = test.extend<ConfigFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  bound: async ({}, use) => {
    await use(settingsFrom);
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  mintedFrom: async ({}, use) => {
    await use(mintedFrom);
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  boundThrough: async ({}, use) => {
    await use(namedThrough);
  },
});
