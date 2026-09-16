// What a LIBRARY consumer exports, compiled under `declaration: true` against
// the published tarballs.
//
// Every binding here is exported on purpose: declaration emit is the check, and
// an unexported binding is never emitted, so it proves nothing. Each one is a
// shape that reaches an unexported internal type of this framework's, which is
// where TS4023 ("has or is using name 'X' … but cannot be named") comes from.
//
// The three example deployments cannot stand in for this file: they extend
// `@btravstack/tsconfig/app.json`, which sets `declaration: false` precisely so
// a wiring mistake's diagnostic is not preceded by two lines of di's brand
// symbols. That is the right trade for an application and it is why none of
// them would ever see the error this file exists to catch.

import { Config, Env } from "@btravstack/config";
import { RuntimePort, type Runtime } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { HttpModule, defineHttp } from "@btravstack/http-server";
import { oc } from "@orpc/contract";
import { OkAsync } from "unthrown";
import { z } from "zod";

// 1. A port and the module that provides it — di's own emit guard's shape,
//    repeated here so a regression is caught by one gate rather than two.
export class Greeter extends Port("Greeter")<{
  readonly greet: (name: string) => string;
}> {}

export const GreetingModule = Module("Greeting")({
  provides: [
    Provider(Greeter)({ inject: {}, value: { greet: (name: string) => `hello, ${name}` } }),
  ],
  exports: [Greeter],
});

// 2. A `Config.provider` that MINTS its own port. The class expression behind
//    it is anonymous, so the emitted type has to reach
//    `PortClassOf`/`PortInstance` — exported from `@btravstack/di` for exactly
//    this, and the reason that export is not dead code.
export const settings = Config.provider("ConsumerSettings")(
  Config.object({ port: Config.port("PORT", { default: 3000 }) }),
);

export const SettingsModule = Module("Settings")({
  needs: [Env],
  provides: [settings],
  exports: [settings],
});

// 3. `defineHttp(...)`'s binding, held whole. Its type names this framework's
//    unexported `FragmentAt` and `Schemes`, which is the case the http-server
//    signature gate skips and therefore never compiled from outside.
export const api = defineHttp();

const contract = {
  hello: oc.input(z.object({ name: z.string() })).output(z.object({ message: z.string() })),
};

export const greetingRouter = api.OrpcRouter(contract)({
  inject: { greeter: Greeter },
  sync: ({ greeter }) => ({
    hello: (_helpers, input) => OkAsync({ message: greeter.greet(input.name) }),
  }),
});

// 4. An `HttpModule` composition root, exported by name. This is the shape that
//    produced TS2883 when the sugar's return type was a named generic alias,
//    and nothing inside the workspace compiles it under `declaration: true`.
export const ConsumerApi = HttpModule("ConsumerApi")({
  router: greetingRouter,
  imports: [GreetingModule, SettingsModule],
});

// 5. A runtime port declared over `RuntimePort`, the shape every runtime
//    package ships and a consumer writing its own transport repeats.
export class ConsumerRuntime extends RuntimePort<Runtime<typeof Greeter>> {}
