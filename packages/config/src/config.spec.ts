import { Ok } from "unthrown";
import { describe, expect } from "vitest";

import { Config, ConfigInvalid, type ConfigField } from "./config.js";
import { it, settingsSchema } from "./test-fixtures.js";

const validate = (env: Record<string, string | undefined>) =>
  settingsSchema["~standard"].validate(env);

describe("Config.object", () => {
  it("falls back to each field's default when nothing is set", () => {
    // GIVEN an environment with none of the variables set
    const env = {};

    // WHEN it is validated
    const result = validate(env);

    // THEN every field carries its default, typed
    expect(result).toEqual({
      value: { port: 3000, host: "0.0.0.0", retries: 3, verbose: false },
    });
  });

  it("reads what a deployment actually supplies, parsed", () => {
    // GIVEN every variable set, as the strings an environment always holds
    const env = { PORT: "8080", HOST: "127.0.0.1", RETRIES: "0", VERBOSE: "yes" };

    // WHEN it is validated
    const result = validate(env);

    // THEN they arrive as their own types rather than as strings
    expect(result).toEqual({
      value: { port: 8080, host: "127.0.0.1", retries: 0, verbose: true },
    });
  });

  it("keeps port 0 expressible, because an ephemeral bind is legal", () => {
    // GIVEN the port a deployment sets when it wants the OS to pick one
    const env = { PORT: "0" };

    // WHEN it is validated
    const result = validate(env);

    // THEN it survives — which is why the guard against a blank value cannot
    // be a lower bound
    expect(result).toEqual(
      expect.objectContaining({ value: expect.objectContaining({ port: 0 }) }),
    );
  });

  it("rejects a variable that is set but empty, rather than defaulting it", () => {
    // GIVEN the shape `Number()` reads as `0`
    const env = { PORT: "" };

    // WHEN it is validated
    const result = validate(env);

    // THEN it is a configuration error, not an absent variable: the default is
    // for a variable nobody set, not one set to nothing
    expect(result).toEqual({ issues: [{ message: "is set but empty", path: ["PORT"] }] });
  });

  it("names every offending variable at once, in declaration order", () => {
    // GIVEN two variables blank and one malformed
    const env = { PORT: "   ", HOST: "\t\n", RETRIES: "abc" };

    // WHEN it is validated
    const result = validate(env);

    // THEN all three are issues, so an operator fixes the deployment in one
    // round trip
    expect(result).toEqual({
      issues: [
        { message: "is set but empty", path: ["PORT"] },
        { message: "is set but empty", path: ["HOST"] },
        { message: 'is not a whole number: "abc"', path: ["RETRIES"] },
      ],
    });
  });

  it("rejects a fraction where a whole number is expected", () => {
    // GIVEN a number that is not an integer
    const env = { PORT: "3.5" };

    // WHEN it is validated
    const result = validate(env);

    // THEN it is named, not truncated
    expect(result).toEqual({
      issues: [{ message: 'is not a whole number: "3.5"', path: ["PORT"] }],
    });
  });

  it("enforces bounds, both ends inclusive", () => {
    // GIVEN a port past the OS's range and a retry count past its ceiling
    const env = { PORT: "70000", RETRIES: "11" };

    // WHEN it is validated
    const result = validate(env);

    // THEN both are out of range, and the message says what the range is
    expect(result).toEqual({
      issues: [
        { message: "must be between 0 and 65535, got 70000", path: ["PORT"] },
        { message: "must be between 0 and 10, got 11", path: ["RETRIES"] },
      ],
    });
  });

  it("rejects a word that is not a boolean", () => {
    // GIVEN a value neither spelling of true nor of false covers
    const env = { VERBOSE: "maybe" };

    // WHEN it is validated
    const result = validate(env);

    // THEN it is an issue rather than a silent `false`
    expect(result).toEqual({
      issues: [{ message: 'is not a boolean: "maybe"', path: ["VERBOSE"] }],
    });
  });

  it("requires a field with no default", () => {
    // GIVEN a schema whose one field has no default, and an environment without it
    const schema = Config.object({ url: Config.string("DATABASE_URL") });

    // WHEN it is validated
    const result = schema["~standard"].validate({});

    // THEN the absence is the issue
    expect(result).toEqual({ issues: [{ message: "is required", path: ["DATABASE_URL"] }] });
  });

  it("reports a field whose parser defects against its variable", () => {
    // GIVEN a field whose parse blows up — a bug in the field, not the environment
    const broken: ConfigField<number> = {
      variable: "BROKEN",
      parse: () =>
        Ok(1).map(() => {
          // oxlint-disable-next-line unthrown/no-throw -- the defect IS the subject under test, and a Defect has no public constructor
          throw new Error("parser bug");
        }),
    };
    const schema = Config.object({ n: broken });

    // WHEN it is validated
    const result = schema["~standard"].validate({ BROKEN: "1" });

    // THEN the validation still answers with issues rather than throwing
    expect(result).toEqual({ issues: [{ message: "Error: parser bug", path: ["BROKEN"] }] });
  });
});

describe("ConfigInvalid", () => {
  it("prints one line per issue, naming the variable", () => {
    // GIVEN issues with a plain path, an object-segment path and no path at all
    const error = new ConfigInvalid({
      port: "HttpConfig",
      issues: [
        { message: "is required", path: ["PORT"] },
        { message: "is set but empty", path: [{ key: "HOST" }] },
        { message: "is not an object" },
      ],
    });

    // WHEN its message is read
    const { message } = error;

    // THEN it names the port and every variable, in order
    expect(message).toBe(
      "HttpConfig could not be configured:\n  PORT: is required\n  HOST: is set but empty\n  (environment): is not an object",
    );
  });
});

describe("Config.provider", () => {
  it("binds the port from the Env the graph provides, parsed", async ({ bound }) => {
    // GIVEN a graph whose Env carries a hand-picked environment
    const env = { PORT: "8080", HOST: "::1" };

    // WHEN the port is resolved out of the built graph
    const settings = bound(env);

    // THEN it holds the parsed values, defaults filled in
    await expect(settings).toBeOkWith({ port: 8080, host: "::1", retries: 3, verbose: false });
  });

  it("answers ConfigInvalid, naming the port and every offending variable", async ({ bound }) => {
    // GIVEN an environment the schema rejects on two counts
    const env = { PORT: "abc", VERBOSE: "" };

    // WHEN the port is resolved
    const settings = bound(env);

    // THEN the modeled error carries the port id and both issues, in order
    await expect(settings).toBeErrWith(
      expect.objectContaining({
        constructor: ConfigInvalid,
        port: "ConfigFixtureSettings",
        issues: [
          { message: 'is not a whole number: "abc"', path: ["PORT"] },
          { message: "is set but empty", path: ["VERBOSE"] },
        ],
      }),
    );
  });

  it("mints the port when given a name, and hands it back on the provider", async ({
    mintedFrom,
  }) => {
    // GIVEN a slice bound with `Config.provider("…", schema)` — no port class written anywhere
    const env = { RETRIES: "5" };

    // WHEN the minted port is resolved through `provider.port`
    const settings = mintedFrom(env);

    // THEN it holds the parsed value: the port exists, typed by the schema's output
    await expect(settings).toBeOkWith({ retries: 5 });
  });

  it("accepts any Standard Schema, an async one included", async ({ boundThrough }) => {
    // GIVEN a hand-written asynchronous schema over the environment
    const schema = {
      "~standard": {
        version: 1 as const,
        vendor: "spec",
        validate: async (input: unknown) => ({
          value: { name: String((input as Record<string, unknown>)["NAME"]) },
        }),
      },
    };

    // WHEN a port is bound through it
    const named = boundThrough(schema, { NAME: "async" });

    // THEN the awaited value is what the graph holds
    await expect(named).toBeOkWith({ name: "async" });
  });
});
