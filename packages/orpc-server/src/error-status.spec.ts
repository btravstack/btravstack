import { authenticated } from "@btravstack/contract";
import { Observers, type Operation, type Settled } from "@btravstack/core";
import { Provider } from "@btravstack/di";
import { HttpAuthenticator, Unauthenticated, granted } from "@btravstack/http-server";
import { it } from "@btravstack/internal-http-fixtures";
import { oc } from "@orpc/contract";
import { openapi } from "@orpc/openapi";
import { ErrAsync, OkAsync, fromSafePromise } from "unthrown";
import { describe, expect } from "vitest";
import { z } from "zod";

import { defineHttp } from "./define-http.js";
import { HttpModule } from "./http-module.js";
import { openApiDocument } from "./openapi.js";

describe("contract-local OpenAPI error statuses", () => {
  it.for([404, 409, 422, 503])(
    "answers a named refusal with its declared %i",
    async (status, { boot }) => {
      // GIVEN a custom error declared beside its HTTP route
      const contract = {
        refuse: oc.meta(openapi({ method: "GET", path: "/refuse" })).errors({
          DOMAIN_REFUSAL: { status, message: "Refused", data: z.object({ id: z.string() }) },
        }),
      };
      const taken: (Operation & Settled)[] = [];
      const observer = Provider.member(Observers)({
        inject: {},
        sync: () => (operation) => (settled) => {
          taken.push({ ...operation, ...settled });
        },
      });
      const router = defineHttp().OrpcRouter(contract)({
        sync: () => ({
          refuse: ({ errors }) => ErrAsync(errors.DOMAIN_REFUSAL({ data: { id: "42" } })),
        }),
      });
      const info = (
        await boot(
          HttpModule("Refusal")({
            router,
            provides: [observer],
            port: 0,
            hostname: "127.0.0.1",
            openapi: true,
          }),
        ).runtimeInfo()
      ).get();

      // WHEN the named error crosses the real HTTP listener
      const response = await fetch(`http://127.0.0.1:${info?.port}/api/refuse`);

      // THEN the status and typed data survive without a defect observation
      expect({
        status: response.status,
        body: await response.json(),
        defects: taken.filter((operation) => operation.name === "defect"),
      }).toEqual({
        status,
        body: expect.objectContaining({
          code: "DOMAIN_REFUSAL",
          defined: true,
          data: { id: "42" },
        }),
        defects: [],
      });
    },
  );

  it.for([undefined, 399, 600, 422.5, "422"])(
    "keeps the fallback for an absent or invalid status %s",
    async (status, { boot }) => {
      // GIVEN an entry with no usable HTTP error status
      const contract = { refuse: oc.errors({ DOMAIN_REFUSAL: { status, message: "Refused" } }) };
      const router = defineHttp().OrpcRouter(contract)({
        sync: () => ({ refuse: ({ errors }) => ErrAsync(errors.DOMAIN_REFUSAL()) }),
      });
      const info = (
        await boot(
          HttpModule("Fallback")({ router, port: 0, hostname: "127.0.0.1", openapi: true }),
        ).runtimeInfo()
      ).get();

      // WHEN the refusal is served
      const response = await fetch(`http://127.0.0.1:${info?.port}/api/refuse`, { method: "POST" });

      // THEN undeclared statuses retain oRPC's default
      expect(response.status).toBe(500);
    },
  );

  it.for(["orders", "billing"] as const)(
    "keeps a shared code local to the %s slice",
    async (domain, { boot }) => {
      // GIVEN two independently declared domains sharing an error spelling
      const contract = {
        orders: { refuse: oc.errors({ REFUSED: { status: 404, message: "Order missing" } }) },
        billing: { refuse: oc.errors({ REFUSED: { status: 409, message: "Invoice conflicts" } }) },
      };
      const api = defineHttp();
      const orders = api.OrpcController(
        contract,
        "orders",
      )({ sync: () => ({ refuse: ({ errors }) => ErrAsync(errors.REFUSED()) }) });
      const billing = api.OrpcController(
        contract,
        "billing",
      )({ sync: () => ({ refuse: ({ errors }) => ErrAsync(errors.REFUSED()) }) });
      const router = api.OrpcRouter(contract)([orders, billing]);
      const info = (
        await boot(
          HttpModule("Domains")({ router, port: 0, hostname: "127.0.0.1", openapi: true }),
        ).runtimeInfo()
      ).get();

      // WHEN the selected slice answers
      const response = await fetch(`http://127.0.0.1:${info?.port}/api/${domain}/refuse`, {
        method: "POST",
      });

      // THEN the other domain cannot overwrite this declaration
      expect(response.status).toBe(domain === "orders" ? 404 : 409);
    },
  );

  it("documents each procedure's local statuses without losing standard errors", async () => {
    // GIVEN domains sharing a code and a procedure with several refusal statuses
    const contract = {
      orders: { refuse: oc.errors({ REFUSED: { status: 404, message: "Order missing" } }) },
      billing: {
        refuse: oc.errors({
          REFUSED: { status: 409, data: z.object({ invoice: z.string() }) },
          INVALID_INVOICE: { status: 422, message: "Invalid invoice" },
          BAD_REQUEST: { message: "Malformed request" },
        }),
      },
    };

    // WHEN the shared contract is documented
    const document = (await openApiDocument(contract)).get();

    // THEN statuses remain local and the standard mapping is retained
    expect({
      orders: Object.keys(document.paths?.["/orders/refuse"]?.post?.responses ?? {}),
      billing: Object.keys(document.paths?.["/billing/refuse"]?.post?.responses ?? {}),
    }).toEqual({ orders: ["200", "404"], billing: ["200", "400", "409", "422"] });
  });

  it.for(["invalid", "missing", "scope", "defect"] as const)(
    "preserves %s failures",
    async (failure, { boot }) => {
      // GIVEN a protected procedure with a declared domain error
      const auth = HttpAuthenticator<{ readonly name: string }, "write">()({
        inject: {},
        sync: () => (headers) =>
          headers.authorization === "Bearer good"
            ? OkAsync(granted({ name: "Ada" }, []))
            : ErrAsync(new Unauthenticated()),
      });
      const api = defineHttp({ authenticators: { user: auth } });
      const leaf = oc.input(z.object({ id: z.string() })).errors({
        DOMAIN_REFUSAL: { status: 422, message: "Refused" },
      });
      const contract = {
        refuse:
          failure === "invalid" || failure === "defect"
            ? leaf
            : authenticated({ user: ["write"] })(leaf),
      };
      const taken: (Operation & Settled)[] = [];
      const observer = Provider.member(Observers)({
        inject: {},
        sync: () => (operation) => (settled) => {
          taken.push({ ...operation, ...settled });
        },
      });
      const router = api.OrpcRouter(contract)({
        sync: () => ({
          refuse: () =>
            failure === "defect"
              ? fromSafePromise(Promise.reject(new Error("private bug")))
              : OkAsync(),
        }),
      });
      const info = (
        await boot(
          HttpModule("Failures")({
            router,
            provides: [observer],
            port: 0,
            hostname: "127.0.0.1",
            openapi: true,
          }),
        ).runtimeInfo()
      ).get();

      // WHEN dispatch fails before or inside the handler
      const response = await fetch(`http://127.0.0.1:${info?.port}/api/refuse`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(failure === "scope" ? { authorization: "Bearer good" } : {}),
        },
        body: JSON.stringify(failure === "invalid" ? {} : { id: "42" }),
      });
      const body = await response.json();

      // THEN framework errors retain their status and defects stay masked and observed
      expect({
        status: response.status,
        body,
        masked: JSON.stringify(body),
        defects: taken
          .filter((operation) => operation.name === "defect")
          .map((operation) => operation.cause),
      }).toEqual({
        status: { invalid: 400, missing: 401, scope: 403, defect: 500 }[failure],
        body: expect.objectContaining({
          code: {
            invalid: "BAD_REQUEST",
            missing: "UNAUTHORIZED",
            scope: "FORBIDDEN",
            defect: "INTERNAL_SERVER_ERROR",
          }[failure],
        }),
        masked: expect.not.stringContaining("private bug"),
        defects: failure === "defect" ? [expect.objectContaining({ message: "private bug" })] : [],
      });
    },
  );
});
