import { Port } from "@btravstack/di";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { Config, type ValueOf } from "./index.js";

const amqpShape = { url: z.string().min(1).default("amqp://localhost") };
class AmqpPort extends Port("Amqp")<ValueOf<typeof amqpShape>> {}
const Amqp = Config(AmqpPort, "AMQP")(amqpShape);

const httpShape = {
  port: z.string().min(1).pipe(z.coerce.number<string>().int()).default(3000),
};
class HttpPort extends Port("Http")<ValueOf<typeof httpShape>> {}
const Http = Config(HttpPort, "HTTP")(httpShape);

describe("Config.parse", () => {
  it("accepts an environment every adapter agrees with", () => {
    // GIVEN a valid environment
    const source = { AMQP_URL: "amqp://broker", HTTP_PORT: "8080" };

    // WHEN every adapter is validated
    // THEN nothing is reported
    expect(Config.parse([Amqp, Http], source)).toBeOk();
  });

  it("reports every wrong variable across every adapter, in one value", () => {
    // GIVEN two adapters wrong at once — the operator's real situation
    const source = { AMQP_URL: "", HTTP_PORT: "abc" };

    // WHEN they are validated
    const outcome = Config.parse([Amqp, Http], source);

    // THEN one error carries both, so one deploy fixes both
    expect(outcome).toBeErrTagged("config/ConfigInvalid", {
      issues: [
        expect.objectContaining({ variable: "AMQP_URL" }),
        expect.objectContaining({ variable: "HTTP_PORT" }),
      ],
    });
  });

  it("returns rather than throws when an adapter's schema validates asynchronously", () => {
    // GIVEN an adapter whose schema validates asynchronously — a shape only
    // `Config.parse`'s type accepts, not something a sync `Result` can run
    const asyncSchema: StandardSchemaV1<string> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) => Promise.resolve({ value: String(value) }),
      },
    };
    class AsyncPort extends Port("Async")<{ value: string }> {}
    const Async = Config(AsyncPort, "ASYNC")({ value: asyncSchema });

    // WHEN it is validated through the public entry point
    // THEN the crash is a Defect, not a `ConfigInvalid` — and it never throws
    expect(() => Config.parse([Async], { ASYNC_VALUE: "x" })).not.toThrow();
    expect(Config.parse([Async], { ASYNC_VALUE: "x" })).toBeDefect();
  });
});
