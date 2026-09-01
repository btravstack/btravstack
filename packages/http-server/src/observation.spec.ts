import { OkAsync } from "unthrown";
import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("the runtime's observations", () => {
  it("observes a served request, dimensioned by answerer and status", async ({ observed }) => {
    // GIVEN the runtime over an observer that records — which is the whole of
    // what a graph does to be instrumented: the runtime asks for no ports
    const { origin, taken } = await observed((_request, response) => {
      response.writeHead(200);
      response.end("ok");
      return OkAsync();
    });

    // WHEN one request is served
    await fetch(`${origin}/rpc/anything`);
    await vi.waitUntil(() => taken().length === 1);

    // THEN the operation carries the transport's own dimensions and no PATH:
    // `/orders/42` would mint a time series per order
    expect(taken()[0]).toEqual({
      component: "http",
      name: "request",
      attributes: { method: "GET", answerer: "/rpc", status: 200 },
      outcome: "ok",
    });
  });

  it("observes the runtime's own 404, which no answerer ever sees", async ({ observed }) => {
    // GIVEN a graph whose one answerer is mounted at `/rpc`
    const { origin, taken } = await observed((_request, response) => {
      response.writeHead(200);
      response.end("ok");
      return OkAsync();
    });

    // WHEN a path no answerer claims is requested — answered by the runtime
    // itself, past every handler
    await fetch(`${origin}/elsewhere`, { method: "DELETE" });
    await vi.waitUntil(() => taken().length === 1);

    // THEN it is observed all the same, with an empty `answerer` naming that
    // nothing claimed the path — an operation only the runtime can report
    expect(taken()[0]).toEqual({
      component: "http",
      name: "request",
      attributes: { method: "DELETE", answerer: "", status: 404 },
      outcome: "ok",
    });
  });

  it("settles a 500 as an error, so the errors half of RED is not the reassuring half", async ({
    observed,
  }) => {
    // GIVEN a handler whose failure the runtime turns into a 500
    const { origin, taken } = await observed(() => {
      // oxlint-disable-next-line unthrown/no-throw -- the defect IS the subject: a synchronous throw is what reaches the runtime's own 500
      throw new Error("bug");
    });

    // WHEN it is called
    await fetch(`${origin}/rpc/anything`).catch(() => undefined);
    await vi.waitUntil(() => taken().length === 1);

    // THEN the outcome says so — a status the client saw as a failure must not
    // be counted beside the successes
    expect(taken()[0]).toEqual({
      component: "http",
      name: "request",
      attributes: { method: "GET", answerer: "/rpc", status: 500 },
      outcome: "error",
    });
  });
});
