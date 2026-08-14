import { Module, Port } from "@btravstack/di";
import { z } from "zod";

import { Config, type ValueOf } from "./index.js";

const shape = {
  url: z.string().default("amqp://localhost"),
  prefetch: z.string().pipe(z.coerce.number<string>()).default(10),
};
class AmqpConfig extends Port("AmqpConfig")<ValueOf<typeof shape>> {}
const AmqpConfigFromEnv = Config(AmqpConfig, "AMQP")(shape);

// The adapter is importable as a module, alongside the source it needs …
const App = Module("App")({
  imports: [AmqpConfigFromEnv, Config.source({})],
  exports: [AmqpConfig],
});

// … and the port it implements is resolvable, with the shape's own output types.
void Module.scoped(App, (ctx) => {
  const value = ctx.get(AmqpConfig);
  const url: string = value.url;
  const prefetch: number = value.prefetch;
  // @ts-expect-error — `nope` is not a key of this port's shape
  const missing = value.nope;
  void [url, prefetch, missing];
  return undefined as never;
});

// A module importing an adapter with no `Config.source` leaves `ConfigSource`
// unmet: a compile error at the call site (di's arity gate on `Needs`), not
// a runtime `WiringDefect` a laundered `never` used to defer this to.
const Unsourced = Module("Unsourced")({ imports: [AmqpConfigFromEnv], exports: [AmqpConfig] });
// @ts-expect-error — `ConfigSource` is unmet: no `Config.source(...)` import
void Module.scoped(Unsourced, (ctx) => {
  void ctx.get(AmqpConfig);
  return undefined as never;
});

// A shape missing a key the port declares does not implement the port: the
// enforcement is what makes "this adapter implements this port" a compile-time
// fact rather than something only discovered once `ctx.get(port)` is read.
class NeedsPrefetch extends Port("NeedsPrefetch")<{ url: string; prefetch: number }> {}
const adaptNeedsPrefetch = Config(NeedsPrefetch, "AMQP");
// @ts-expect-error — shape is missing `prefetch`, which the port declares
adaptNeedsPrefetch({ url: z.string().default("amqp://localhost") });

// A shape with the wrong output type for a key the port declares does not
// implement the port either.
class NeedsNumericPrefetch extends Port("NeedsNumericPrefetch")<{ prefetch: number }> {}
const adaptNeedsNumericPrefetch = Config(NeedsNumericPrefetch, "AMQP");
// @ts-expect-error — `prefetch` parses to a `string`, not the `number` the port declares
adaptNeedsNumericPrefetch({ prefetch: z.string().default("10") });
