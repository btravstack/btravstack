import { Module, Port, Provider } from "@btravstack/di";
import { OkAsync } from "unthrown";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { Config, type ValueOf } from "./slice.js";
import { source } from "./source.js";

const amqpShape = { url: z.string().min(1).default("amqp://localhost") };
class AmqpConfig extends Port("AmqpConfig")<ValueOf<typeof amqpShape>> {}
const AmqpConfigFromEnv = Config(AmqpConfig, "AMQP")(amqpShape);

describe("a config adapter", () => {
  it("implements the port it is given, injected under the port's own identity", async () => {
    // GIVEN a module importing the env adapter and a source
    const App = Module("App")({
      imports: [AmqpConfigFromEnv, source({ AMQP_URL: "amqp://broker" })],
      exports: [AmqpConfig],
    });

    // WHEN the graph is built and the port is resolved
    const value = await Module.scoped(App, (ctx) => OkAsync(ctx.get(AmqpConfig)));

    // THEN the adapter served the port it was declared for
    expect(value).toBeOkWith({ url: "amqp://broker" });
  });

  it("is parsed once even when two modules import it", async () => {
    // GIVEN a port whose validator counts how many times it actually runs
    let parses = 0;
    const countedShape = {
      url: z
        .string()
        .min(1)
        .default("amqp://localhost")
        .transform((value) => {
          parses++;
          return value;
        }),
    };
    class CountedConfig extends Port("CountedConfig")<ValueOf<typeof countedShape>> {}
    const CountedConfigFromEnv = Config(CountedConfig, "COUNTED")(countedShape);

    // AND two modules that both import that adapter
    const A = Module("A")({ imports: [CountedConfigFromEnv], exports: [CountedConfig] });
    const B = Module("B")({ imports: [CountedConfigFromEnv], exports: [CountedConfig] });
    const Both = Module("Both")({
      imports: [A, B, source({ COUNTED_URL: "amqp://broker" })],
      exports: [CountedConfig],
    });

    // WHEN the graph is built
    const value = await Module.scoped(Both, (ctx) => OkAsync(ctx.get(CountedConfig)));

    // THEN di deduped the module — one provider ran, so the validator ran once
    expect(value).toBeOkWith({ url: "amqp://broker" });
    expect(parses).toBe(1);
  });

  it("names its module after its prefix, for a legible graph", () => {
    // GIVEN an env adapter
    // WHEN its module name is read
    // THEN it says which configuration it is, not which port it implements
    expect(AmqpConfigFromEnv.name).toBe("Config(AMQP)");
  });

  it("rejects a prefix that is not upper-snake-case, at declaration", () => {
    // GIVEN a lowercase prefix — `Config(port, "amqp")` would derive
    // `amqp_URL`, a variable no operator will ever set
    // WHEN the adapter is declared
    // THEN the mistake is caught immediately, not left to fall back silently
    expect(() =>
      Config(AmqpConfig, "amqp")({ url: z.string().default("amqp://localhost") }),
    ).toThrow(/upper-snake-case/);
  });

  it("makes a skipped validation a defect, not a silent wrong value", async () => {
    // GIVEN an environment the schema rejects, reached WITHOUT the kernel
    // having run `Config.parse` first — the precondition the adapter's
    // provider documents but cannot itself enforce
    const strictShape = { url: z.string().min(1) };
    class StrictConfig extends Port("StrictConfig")<ValueOf<typeof strictShape>> {}
    const StrictFromEnv = Config(StrictConfig, "STRICT")(strictShape);

    const App = Module("App")({
      imports: [StrictFromEnv, source({ STRICT_URL: "" })],
      exports: [StrictConfig],
    });

    // WHEN the graph is built anyway
    const built = await Module.scoped(App, (ctx) => OkAsync(ctx.get(StrictConfig)));

    // THEN it is a Defect carrying the tagged error — a bug in the caller who
    // skipped validation, never an `Err` the application could branch on, and
    // never a wrong value that boots
    expect(built).toBeDefect();
  });

  it("lets a port the env adapter implements be provided as a literal instead, with no config module involved", async () => {
    // GIVEN the exact same port `AmqpConfigFromEnv` implements, and a
    // consumer that only ever depends on the port — never on `Config`
    const readUrl = (ctx: { get: (port: typeof AmqpConfig) => ValueOf<typeof amqpShape> }) =>
      OkAsync(ctx.get(AmqpConfig).url);

    // WHEN a test hands the port a literal, ordinary di provider — no
    // `Config`, no `ConfigSource`, no environment
    const Fake = Module("Fake")({
      provides: [Provider(AmqpConfig)({ value: { url: "amqp://fake" } })],
      exports: [AmqpConfig],
    });

    // THEN the same consumer resolves it unchanged: the port is adaptable
    const value = await Module.scoped(Fake, readUrl);
    expect(value).toBeOkWith("amqp://fake");
  });
});
