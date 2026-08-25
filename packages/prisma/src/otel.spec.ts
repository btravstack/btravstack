import { Tracer } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";
import { OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { prismaTracing } from "./otel.js";

/** The versioned key `@prisma/instrumentation` puts its tracing helper on. */
const KEY = Object.keys(globalThis).find((k) => k.endsWith("PRISMA_INSTRUMENTATION"));

const helperPresent = (): boolean => {
  const key = KEY ?? "V7_PRISMA_INSTRUMENTATION";
  const holder = (globalThis as Record<string, { helper?: unknown } | undefined>)[key];
  return holder?.helper !== undefined;
};

describe("prismaTracing", () => {
  it("turns Prisma's tracing on for the life of the scope", async ({ telemetry }) => {
    // GIVEN a graph importing the module, with the Tracer it orders itself behind
    const root = Module("Root")({
      imports: [prismaTracing()],
      provides: [Provider(Tracer)({ value: telemetry.tracer })],
      exports: [Tracer],
    });

    // WHEN a scope opens over it and closes again
    const during = await Module.scoped(root, () => OkAsync(helperPresent()));

    // THEN the global helper was installed inside the scope and removed after —
    // nothing had to resolve the port, since di builds a scope's providers eagerly
    expect({ during: during.isOk() && during.value, after: helperPresent() }).toEqual({
      during: true,
      after: false,
    });
  });
});
