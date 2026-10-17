import { Observers } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { describe, expect, it } from "vitest";

import { HttpClient, httpClient, type HttpPolicy } from "./index.js";

describe("application composition", () => {
  it("injects an observed client from the application's policy port without URL details", async () => {
    // GIVEN
    class Policy extends Port("ApplicationHttpPolicy")<HttpPolicy> {}
    const seen: unknown[] = [];
    const root = Module("Outbound")({
      imports: [httpClient(Policy)],
      provides: [
        Provider(Policy)({
          inject: {},
          value: { origins: ["https://api.example"], deadlineMs: 1000, maxResponseBytes: 1024 },
        }),
        Provider.member(Observers)({
          inject: {},
          value: (operation) => {
            seen.push(operation);
            return (settled) => {
              seen.push(settled.outcome);
            };
          },
        }),
      ],
      exports: [HttpClient],
    });
    // WHEN
    const result = await Module.scoped(root, (ctx) =>
      ctx.get(HttpClient).request({ url: "https://user:secret@api.example/private?token=secret" }),
    );
    // THEN
    expect({ result: result.isErr(), seen }).toEqual({
      result: true,
      seen: [
        { component: "http-client", name: "request", attributes: { operation: "request" } },
        "error",
      ],
    });
  });
});
