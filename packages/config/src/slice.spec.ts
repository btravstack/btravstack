import { Module, Provider } from "@btravstack/di";
import { OkAsync } from "unthrown";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { Config, type ValueOf } from "./slice.js";
import { source } from "./source.js";

const amqpShape = { url: z.string().min(1).default("amqp://localhost") };
const amqpConfig = Config("AmqpConfig")(amqpShape, { prefix: "AMQP" });

describe("a config", () => {
  it("implements the port it declares, injected under its own identity", async () => {
    // GIVEN a module importing the config as a module, and a source
    const App = Module("App")({
      imports: [amqpConfig, source({ AMQP_URL: "amqp://broker" })],
      exports: [amqpConfig],
    });

    // WHEN the graph is built and the port is resolved
    const value = await Module.scoped(App, (ctx) => OkAsync(ctx.get(amqpConfig)));

    // THEN the adapter served the port it was declared for
    expect(value).toBeOkWith({ url: "amqp://broker" });
  });

  it("is parsed once even when two modules import it", async () => {
    // GIVEN a config whose validator counts how many times it actually runs
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
    const countedConfig = Config("CountedConfig")(countedShape, { prefix: "COUNTED" });

    // AND two modules that both import that config
    const A = Module("A")({ imports: [countedConfig], exports: [countedConfig] });
    const B = Module("B")({ imports: [countedConfig], exports: [countedConfig] });
    const Both = Module("Both")({
      imports: [A, B, source({ COUNTED_URL: "amqp://broker" })],
      exports: [countedConfig],
    });

    // WHEN the graph is built
    const value = await Module.scoped(Both, (ctx) => OkAsync(ctx.get(countedConfig)));

    // THEN di deduped the module — one provider ran, so the validator ran once
    expect(value).toBeOkWith({ url: "amqp://broker" });
    expect(parses).toBe(1);
  });

  it("names its module after its prefix, for a legible graph", () => {
    // GIVEN a config
    // WHEN its module name is read
    // THEN it says which configuration it is, not which id it was declared under
    expect(amqpConfig.name).toBe("Config(AMQP)");
  });

  it("rejects a prefix that is not upper-snake-case, at declaration", () => {
    // GIVEN a lowercase explicit prefix — `Config(id, { prefix: "amqp" })`
    // would derive `amqp_URL`, a variable no operator will ever set
    // WHEN the config is declared
    // THEN the mistake is caught immediately, not left to fall back silently
    expect(() =>
      Config("AmqpConfig")({ url: z.string().default("amqp://localhost") }, { prefix: "amqp" }),
    ).toThrow(/upper-snake-case/);
  });

  it("defaults its prefix to the screaming-snake form of its identity", () => {
    // GIVEN a config declared with no `options.prefix` — a distinct id from
    // `amqpConfig` above, so this doesn't also trip di's duplicate-id warning
    const defaulted = Config("HttpConfig")({ port: z.string().default("3000") });

    // WHEN the resolved prefix is read
    // THEN it is the identity, shouted and underscored
    expect(defaulted.prefix).toBe("HTTP_CONFIG");
    expect(defaulted.name).toBe("Config(HTTP_CONFIG)");
  });

  it("uses an explicit prefix verbatim, not derived from the identity", () => {
    // GIVEN a config declared with an explicit `options.prefix`
    // WHEN the resolved prefix is read
    // THEN it is exactly what was given, unrelated to the identity's own spelling
    expect(amqpConfig.prefix).toBe("AMQP");
  });

  it("makes a skipped validation a defect, not a silent wrong value", async () => {
    // GIVEN an environment the schema rejects, reached WITHOUT the kernel
    // having run `Config.parse` first — the precondition the adapter's
    // provider documents but cannot itself enforce
    const strictShape = { url: z.string().min(1) };
    const strictConfig = Config("StrictConfig")(strictShape, { prefix: "STRICT" });

    const App = Module("App")({
      imports: [strictConfig, source({ STRICT_URL: "" })],
      exports: [strictConfig],
    });

    // WHEN the graph is built anyway
    const built = await Module.scoped(App, (ctx) => OkAsync(ctx.get(strictConfig)));

    // THEN it is a Defect carrying the tagged error — a bug in the caller who
    // skipped validation, never an `Err` the application could branch on, and
    // never a wrong value that boots
    expect(built).toBeDefect();
  });

  it("lets a config be provided as a literal, with no config module or environment involved", async () => {
    // GIVEN a consumer that never imports `amqpConfig` as a module — only
    // depends on it as a port token
    const readUrl = (ctx: { get: (port: typeof amqpConfig) => ValueOf<typeof amqpShape> }) =>
      OkAsync(ctx.get(amqpConfig).url);

    // WHEN a test hands it a literal, ordinary di provider — no
    // `Config.source`, no environment, and `amqpConfig` never appears in
    // `imports:` anywhere in this graph
    const Fake = Module("Fake")({
      provides: [Provider(amqpConfig)({ value: { url: "amqp://fake" } })],
      exports: [amqpConfig],
    });

    // THEN the same consumer resolves it unchanged: `amqpConfig` is a token
    // like any other port, and its module statics (name/imports/provides/
    // exports) are only consulted when it appears in `imports:` — a graph
    // that never puts it there never reaches them.
    const value = await Module.scoped(Fake, readUrl);
    expect(value).toBeOkWith("amqp://fake");
  });
});
