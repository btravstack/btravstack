import { Entity } from "@btravstack/entity";
import { oc } from "@orpc/contract";
import { openapi } from "@orpc/openapi";
import { Temporal as PortableTemporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { openApiDocument } from "./openapi.js";

describe("OpenAPI codec contracts", () => {
  it("describes native calendar dates and instants in GET parameters, POST bodies and responses", async () => {
    // Arrange
    const Temporal =
      (Reflect.get(globalThis, "Temporal") as typeof PortableTemporal | undefined) ??
      PortableTemporal;
    const date = Entity.codec(z.iso.date(), z.instanceof(Temporal.PlainDate), {
      decode: (value) => Temporal.PlainDate.from(value),
      encode: (value) => value.toString(),
    });
    const instant = Entity.codec(z.iso.datetime(), z.instanceof(Temporal.Instant), {
      decode: (value) => Temporal.Instant.from(value),
      encode: (value) => value.toString(),
    });
    const payload = z.object({ schedule: z.object({ date, at: instant }) });
    const contract = {
      find: oc
        .meta(openapi({ method: "GET", path: "/calendar/{date}" }))
        .input(z.object({ date, since: instant.optional() }))
        .output(payload),
      create: oc
        .meta(openapi({ method: "POST", path: "/calendar" }))
        .input(payload)
        .output(payload),
    };

    // Act
    const document = (await openApiDocument(contract)).get();

    // Assert
    expect(document.paths).toMatchObject({
      "/calendar/{date}": {
        get: {
          parameters: [
            {
              name: "date",
              in: "path",
              required: true,
              schema: { type: "string", format: "date" },
            },
            { name: "since", in: "query", schema: { type: "string", format: "date-time" } },
          ],
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    properties: {
                      schedule: {
                        properties: {
                          date: { type: "string", format: "date" },
                          at: { type: "string", format: "date-time" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/calendar": {
        post: {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  properties: {
                    schedule: {
                      properties: {
                        date: { type: "string", format: "date" },
                        at: { type: "string", format: "date-time" },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    properties: {
                      schedule: {
                        properties: {
                          date: { type: "string", format: "date" },
                          at: { type: "string", format: "date-time" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  });

  it.each(["GET", "POST"] as const)("preserves %s input conversion defects", async (method) => {
    // Arrange
    const contract = {
      broken: oc
        .meta(openapi({ method, path: "/broken" }))
        .input(z.object({ native: z.custom<URL>() })),
      valid: oc.meta(openapi({ method: "GET", path: "/valid" })).output(z.string()),
    };

    // Act
    const result = await openApiDocument(contract);

    // Assert
    expect(result).toBeDefectWith(
      expect.objectContaining({ message: "Custom types cannot be represented in JSON Schema" }),
    );
  });

  it("fails the whole document when a response schema cannot be represented", async () => {
    // Arrange
    const contract = {
      broken: oc.output(z.object({ native: z.custom<URL>() })),
      valid: oc.output(z.string()),
    };

    // Act
    const result = await openApiDocument(contract);

    // Assert
    expect(result).toBeDefectWith(
      expect.objectContaining({ message: "Custom types cannot be represented in JSON Schema" }),
    );
  });
});
