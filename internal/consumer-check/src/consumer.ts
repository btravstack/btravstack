import { webcrypto } from "node:crypto";
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
import { HealthChecks, RuntimePort, type Runtime } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { Entity } from "@btravstack/entity";
import { GraphqlModule, graphql } from "@btravstack/graphql-server";
import { httpClient, HttpClient, type HttpPolicy } from "@btravstack/http-client";
import { defineAuth } from "@btravstack/http-server";
import { deriveKey, type EnvelopeKeysService, type KeyGeneration } from "@btravstack/keys";
import { mcp } from "@btravstack/mcp-server";
import { HttpModule, defineHttp } from "@btravstack/orpc-server";
import {
  OutboxPublisher,
  OutboxRuntime,
  OutboxStore,
  memoryOutboxStore,
  outbox,
  outboxRuntime,
} from "@btravstack/outbox";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { oc } from "@orpc/contract";
import { createSchema } from "graphql-yoga";
import { OkAsync, fromSafePromise } from "unthrown";
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
export const namespacedApi = defineHttp({ namespace: "consumer" });

const contract = {
  hello: oc.input(z.object({ name: z.string() })).output(z.object({ message: z.string() })),
};

export const namespacedController = namespacedApi.OrpcController(
  contract,
  "hello",
)({
  inject: { greeter: Greeter },
  sync:
    ({ greeter }) =>
    (_helpers, input) =>
      OkAsync({ message: greeter.greet(input.name) }),
});
export const namespacedRouter = namespacedApi.OrpcRouter(contract)([namespacedController]);

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

// 6. An exported entity declaration must also emit against the packed package.
export class ConsumerAccount extends Entity("ConsumerAccount")({
  id: Entity.field(z.string().brand("ConsumerAccountId"), { identity: true }),
  name: Entity.field(z.string().min(1), { unbranded: true }),
}) {}

// 7. An outbox relay composed with the application's own publisher, exported
//    as a slice: the shape whose type reaches `outbox()`'s unexported config
//    and relay ports.
export const RelaySlice = Module("RelaySlice")({
  imports: [outbox({ tenants: ["acme"] })],
  provides: [Provider(OutboxPublisher)({ inject: {}, value: { publish: () => OkAsync() } })],
  exports: [OutboxPublisher],
});

export const ConsumerGraphqlApi = GraphqlModule("ConsumerGraphqlApi")({
  answerer: graphql(defineAuth(), {
    schema: createSchema({ typeDefs: "type Query { hello: String }" }),
  }),
  imports: [GreetingModule],
});

export const consumerMcp = mcp(defineAuth(), {
  server: () => new McpServer({ name: "consumer", version: "1.0.0" }),
});

export const StandaloneRelay = Module("StandaloneRelay")({
  imports: [outboxRuntime({ tenants: ["acme"] })],
  provides: [
    Provider(OutboxStore)({ inject: {}, value: memoryOutboxStore() }),
    Provider(OutboxPublisher)({ inject: {}, value: { publish: () => OkAsync() } }),
  ],
  exports: [OutboxRuntime, HealthChecks],
});

export class OutboundPolicy extends Port("ConsumerOutboundPolicy")<HttpPolicy> {}
export const OutboundHttp = Module("ConsumerOutboundHttp")({
  imports: [httpClient(OutboundPolicy)],
  provides: [
    Provider(OutboundPolicy)({
      inject: {},
      value: { origins: ["https://api.example"], deadlineMs: 1000, maxResponseBytes: 1024 },
    }),
  ],
  exports: [HttpClient],
});

export const encryptPayload = (keys: EnvelopeKeysService, generation: KeyGeneration) =>
  keys.rootKey(generation).flatMap((root) =>
    deriveKey(
      root,
      { namespace: "consumer", purpose: "seal", version: 1 },
      {
        algorithm: { name: "AES-GCM", length: 256 },
        usages: ["encrypt"],
      },
    ).flatMap((key) =>
      fromSafePromise(
        webcrypto.subtle.encrypt(
          { name: "AES-GCM", iv: webcrypto.getRandomValues(new Uint8Array(12)) },
          key,
          new Uint8Array(1),
        ),
      ),
    ),
  );

type ConsumerRootKey = Extract<
  Awaited<ReturnType<EnvelopeKeysService["rootKey"]>>,
  { tag: "Ok" }
>["value"];
type MustBeFalse<T extends false> = T;
export type ConsumerRootKeyIsTyped = MustBeFalse<0 extends 1 & ConsumerRootKey ? true : false>;
