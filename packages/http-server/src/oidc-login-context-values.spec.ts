import { Ok, Err } from "unthrown";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { loginContextFor, OidcLoginRefused } from "./oidc-login-context.js";

describe("OIDC login context values", () => {
  const request = {
    headers: {},
    method: "GET",
    url: "/auth/login",
    signal: new AbortController().signal,
  };
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1n,
    Symbol("intent"),
    new Date(),
    new Map(),
    () => "intent",
    cyclic,
    Array(1),
    Object.assign(Array(1), { extra: "value" }),
    Object.setPrototypeOf(["original"], { toJSON: () => ["replaced"] }),
    { nested: undefined },
    { value: "x".repeat(1025) },
    { value: "é".repeat(600) },
    Object.defineProperty({}, "intent", { get: () => "tenant", enumerable: true }),
    { [Symbol("hidden")]: "tenant" },
  ])("refuses non-JSON or oversized context %#", async (input) => {
    // Arrange
    const context = loginContextFor({ schema: z.unknown(), resolve: () => Ok(input) }, {});
    // Act
    const result = await context.prepare(request);
    // Assert
    expect(result).toBeOkWith(undefined);
  });

  it.each([null, true, false, 4, "tenant", ["tenant", 3], { tenant: "one" }])(
    "preserves JSON intent %#",
    async (input) => {
      // Arrange
      const context = loginContextFor({ schema: z.unknown(), resolve: () => Ok(input) }, {});
      // Act
      const result = await context
        .prepare(request)
        .flatMap((prepared) => context.read(prepared?.serialized));
      // Assert
      expect(result).toBeOkWith(input);
    },
  );

  it("revalidates original input instead of transforming schema output twice", async () => {
    // Arrange
    const context = loginContextFor(
      { schema: z.string().transform(Number), resolve: () => Ok("42") },
      {},
    );
    // Act
    const result = await context
      .prepare(request)
      .flatMap((prepared) => context.read(prepared?.serialized));
    // Assert
    expect(result).toBeOkWith(42);
  });

  it("refuses explicit policy errors", async () => {
    // Arrange
    const context = loginContextFor(
      { schema: z.string(), resolve: () => Err(new OidcLoginRefused()) },
      {},
    );
    // Act
    const result = await context.prepare(request);
    // Assert
    expect(result).toBeOkWith(undefined);
  });

  it("derives allowlisted parameters from validated intent", async () => {
    // Arrange
    const context = loginContextFor(
      {
        schema: z.object({ connection: z.string() }),
        resolve: () => Ok({ connection: "enterprise" }),
        allowedParameters: ["connection"],
        authorizationParameters: (intent) => ({ connection: intent.connection }),
      },
      {},
    );
    // Act
    const result = await context.prepare(request).map((prepared) => ({
      serialized: prepared?.serialized,
      parameters: [...(prepared?.parameters ?? [])],
    }));
    // Assert
    expect(result).toBeOkWith({
      serialized: '{"connection":"enterprise"}',
      parameters: [["connection", "enterprise"]],
    });
  });

  it.each([undefined, "{", "null", '"wrong"', JSON.stringify("x".repeat(1025))])(
    "refuses invalid callback input %#",
    async (serialized) => {
      // Arrange
      const context = loginContextFor(
        { schema: z.object({ tenant: z.string() }), resolve: () => Ok({ tenant: "one" }) },
        {},
      );
      // Act
      const result = await context.read(serialized);
      // Assert
      expect(result).toBeOkWith(undefined);
    },
  );

  it("refuses schema-invalid initial input", async () => {
    // Arrange
    const context = loginContextFor(
      { schema: z.object({ tenant: z.string() }), resolve: () => Ok({ tenant: 3 }) },
      {},
    );
    // Act
    const result = await context.prepare(request);
    // Assert
    expect(result).toBeOkWith(undefined);
  });

  it.each([
    "client_id",
    "CLIENT_ID",
    "client_secret",
    "redirect_uri",
    "scope",
    "response_type",
    "response_mode",
    "state",
    "nonce",
    "code_challenge",
    "code_challenge_method",
    "code_verifier",
    "request",
    "request_uri",
  ])("refuses protected parameter %s even when allowed", async (name) => {
    // Arrange
    const context = loginContextFor(
      {
        schema: z.string(),
        resolve: () => Ok("one"),
        allowedParameters: [name],
        authorizationParameters: () => new URLSearchParams([[name, "override"]]),
      },
      {},
    );
    // Act
    const result = await context.prepare(request);
    // Assert
    expect(result).toBeOkWith(undefined);
  });

  it.each([{ allowedParameters: [] }, { allowedParameters: ["connection"] }])(
    "refuses unallowed or duplicate parameters %#",
    async ({ allowedParameters }) => {
      // Arrange
      const context = loginContextFor(
        {
          schema: z.string(),
          resolve: () => Ok("one"),
          allowedParameters,
          authorizationParameters: () =>
            new URLSearchParams([
              ["connection", "one"],
              ["connection", "two"],
            ]),
        },
        {},
      );
      // Act
      const result = await context.prepare(request);
      // Assert
      expect(result).toBeOkWith(undefined);
    },
  );
});
