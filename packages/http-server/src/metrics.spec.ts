import { OkAsync } from "unthrown";
import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("the runtime's RED metrics", () => {
  it("counts a served request and times it, dimensioned by answerer and status", async ({
    metered,
  }) => {
    // GIVEN the default composition — `instrumented` is on unless a root says
    // otherwise — with a meter that records
    const { origin, taken } = await metered((_request, response) => {
      response.writeHead(200);
      response.end("ok");
      return OkAsync();
    });

    // WHEN one request is served
    await fetch(`${origin}/rpc/anything`);
    await vi.waitUntil(() => taken().length === 2);

    // THEN both instruments carry the same dimensions, and neither carries the
    // PATH: `/orders/42` would mint a time series per order
    expect(taken().map(({ instrument, attributes }) => ({ instrument, attributes }))).toEqual([
      {
        instrument: "btravstack.http.requests",
        attributes: { method: "GET", answerer: "/rpc", status: 200 },
      },
      {
        instrument: "btravstack.http.duration",
        attributes: { method: "GET", answerer: "/rpc", status: 200 },
      },
    ]);
  });

  it("records the runtime's own 404, which no answerer ever sees", async ({ metered }) => {
    // GIVEN a graph whose one answerer is mounted at `/rpc`
    const { origin, taken } = await metered((_request, response) => {
      response.writeHead(200);
      response.end("ok");
      return OkAsync();
    });

    // WHEN a path no answerer claims is requested — answered by the runtime
    // itself, past every handler
    await fetch(`${origin}/elsewhere`, { method: "DELETE" });
    await vi.waitUntil(() => taken().length === 2);

    // THEN the errors half of RED covers it, with an empty `answerer` naming
    // that nothing claimed the path — a metric only the runtime can record
    expect(taken()[0]).toEqual({
      instrument: "btravstack.http.requests",
      value: 1,
      attributes: { method: "DELETE", answerer: "", status: 404 },
    });
  });
});
