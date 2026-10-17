import { ErrAsync, OkAsync, fromSafeThrowable } from "unthrown";
import { describe, expect, it } from "vitest";

import { httpClientFetch, HttpCancelled } from "./index.js";

describe("fetch protocol edge", () => {
  it.each([
    [new Request("https://api.example"), undefined],
    ["https://api.example", { method: "CONNECT" }],
    ["https://api.example", { body: new Blob() }],
    ["https://api.example", { credentials: "include" }],
  ] as const)("rejects unsupported request shapes", async (input, init) => {
    // GIVEN
    const fetch = httpClientFetch({
      request: () => OkAsync({ status: 200, headers: {}, body: new Uint8Array() }),
    });
    // WHEN
    const result = fetch(input, init);
    // THEN
    await expect(result).rejects.toMatchObject({ _tag: "HttpPolicyRejected" });
  });
  it("rejects concrete boundary failures", async () => {
    // GIVEN
    const fetch = httpClientFetch({ request: () => ErrAsync(new HttpCancelled()) });
    // WHEN
    const result = fetch("https://api.example");
    // THEN
    await expect(result).rejects.toMatchObject({ _tag: "HttpCancelled" });
  });
  it("preserves defects across the fetch edge", async () => {
    // GIVEN
    const fetch = httpClientFetch({
      request: () =>
        fromSafeThrowable(() => {
          // oxlint-disable-next-line unthrown/no-throw -- Deliberate defect to test the fetch edge.
          throw new Error("defect");
        })().toAsync(),
    });
    // WHEN
    const result = fetch("https://api.example");
    // THEN
    await expect(result).rejects.toThrow("defect");
  });
  it.each([undefined, null, "hello", new Uint8Array([65])])(
    "preserves HTTP error responses",
    async (body) => {
      // GIVEN
      const fetch = httpClientFetch({
        request: () =>
          OkAsync({
            status: 400,
            headers: { "content-type": "text/plain" },
            body: new Uint8Array([110, 111]),
          }),
      });
      // WHEN
      const response = await fetch(new URL("https://api.example"), {
        method: "POST",
        ...(body === undefined ? {} : { body }),
      });
      // THEN
      expect({ status: response.status, body: await response.text() }).toEqual({
        status: 400,
        body: "no",
      });
    },
  );
});
