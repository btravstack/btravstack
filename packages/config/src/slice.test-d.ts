import { Module } from "@btravstack/di";
import { z } from "zod";

import { Config, type ConfigType } from "./index.js";

const shape = {
  url: z.string().default("amqp://localhost"),
  prefetch: z.string().pipe(z.coerce.number<string>()).default(10),
};
const amqpConfig = Config("AmqpConfig")(shape, { prefix: "AMQP" });

// The config is importable as a module, alongside the source it needs …
const App = Module("App")({
  imports: [amqpConfig, Config.source({})],
  exports: [amqpConfig],
});

// … and resolvable as the port it is, with the shape's own output types.
void Module.scoped(App, (ctx) => {
  const value = ctx.get(amqpConfig);
  const url: string = value.url;
  const prefetch: number = value.prefetch;
  // @ts-expect-error — `nope` is not a key of this config's shape
  const missing = value.nope;
  void [url, prefetch, missing];
  return undefined as never;
});

// `ConfigType` recovers the parsed shape without reaching for di's own
// `ServiceOf` — the same type `ctx.get(amqpConfig)` above resolves to.
type Amqp = ConfigType<typeof amqpConfig>;
const fromType: Amqp = { url: "amqp://broker", prefetch: 5 };
// @ts-expect-error — `nope` is not a key of the parsed shape
const badFromType: Amqp = { url: "amqp://broker", prefetch: 5, nope: true };
void [fromType, badFromType];

// A module importing a config with no `Config.source` leaves `ConfigSource`
// unmet: a compile error at the call site (di's arity gate on `Needs`), not
// a runtime `WiringDefect` a laundered `never` used to defer this to.
const Unsourced = Module("Unsourced")({ imports: [amqpConfig], exports: [amqpConfig] });
// @ts-expect-error — `ConfigSource` is unmet: no `Config.source(...)` import
void Module.scoped(Unsourced, (ctx) => {
  void ctx.get(amqpConfig);
  return undefined as never;
});
