import { oc } from "@orpc/contract";
import { openapi } from "@orpc/openapi";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as mini from "zod/mini";

import { openApiDocument } from "./openapi.js";

describe("OpenAPI absent bodies", () => {
  it.each(
    [
      { label: "void", schema: z.void() },
      { label: "undefined", schema: z.undefined() },
      { label: "mini void", schema: mini.void() },
      { label: "mini undefined", schema: mini.undefined() },
    ].flatMap((entry) => (["GET", "POST"] as const).map((method) => ({ ...entry, method }))),
  )(
    "preserves explicit $label $method input and output as no content",
    async ({ schema, method }) => {
      // GIVEN
      const contract = {
        absent: oc.meta(openapi({ method })),
        explicit: oc.meta(openapi({ method })).input(schema).output(schema),
      };
      const noContent = {
        request: undefined,
        responses: { "200": { description: "OK", content: {} } },
      };

      // WHEN
      const document = (await openApiDocument(contract)).get();
      const key = method.toLowerCase() as "get" | "post";
      const absent = document.paths!["/absent"]![key]!;
      const explicit = document.paths!["/explicit"]![key]!;

      // THEN
      expect(
        [absent, explicit].map((operation) => ({
          request: operation.requestBody,
          responses: operation.responses,
        })),
      ).toEqual([noContent, noContent]);
    },
  );

  it.each([
    {
      label: "optional",
      schema: z.string().optional(),
      request: undefined,
      response: { type: "string" },
    },
    {
      label: "defaulted",
      schema: z.string().default("ready"),
      request: undefined,
      response: { type: "string", default: "ready" },
    },
  ])(
    "preserves the $label JSON body instead of dropping it",
    async ({ schema, request, response }) => {
      // GIVEN
      const contract = { body: oc.input(schema).output(schema) };

      // WHEN
      const document = (await openApiDocument(contract)).get();
      const operation = document.paths!["/body"]!.post!;

      // THEN
      const body = operation.requestBody as { required?: boolean; content: unknown };
      expect({
        required: body.required,
        content: body.content,
        responses: operation.responses,
      }).toMatchObject({
        required: request,
        content: { "application/json": { schema: { type: "string" } } },
        responses: { "200": { content: { "application/json": { schema: response } } } },
      });
    },
  );

  it.each([
    { label: "optional native", schema: z.custom<URL>().optional() },
    { label: "mixed absence and native", schema: z.union([z.undefined(), z.custom<URL>()]) },
  ])("keeps $label conversion failure in the defect channel", async ({ schema }) => {
    // GIVEN
    const contract = { broken: oc.input(schema).output(schema), valid: oc.output(z.string()) };

    // WHEN
    const answer = await openApiDocument(contract);

    // THEN
    expect(answer).toBeDefect();
  });

  it("preserves a generic conversion defect even when undefined validates", async () => {
    // GIVEN
    const cause = new Error("generic conversion failed");
    const schema = {
      "~standard": {
        version: 1 as const,
        vendor: "generic",
        validate: () => ({ value: undefined }),
        jsonSchema: {
          input: () => {
            // oxlint-disable-next-line unthrown/no-throw -- A third-party converter's original defect must survive absence handling.
            throw cause;
          },
          output: () => ({ type: "string" }),
        },
      },
    };
    const contract = { broken: oc.input(schema) };

    // WHEN
    const answer = await openApiDocument(contract);

    // THEN
    expect(answer).toBeDefectWith(cause);
  });

  it("converts an opaque Standard Schema wrapper without relying on vendor internals", async () => {
    // GIVEN
    const schema = { "~standard": z.string()["~standard"] };
    const contract = { wrapped: oc.input(schema).output(schema) };

    // WHEN
    const document = (await openApiDocument(contract)).get();

    // THEN
    expect(document.paths!["/wrapped"]!.post).toMatchObject({
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "string" } } },
      },
      responses: { "200": { content: { "application/json": { schema: { type: "string" } } } } },
    });
  });
});
