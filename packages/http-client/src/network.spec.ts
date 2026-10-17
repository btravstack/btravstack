import { gzipSync } from "node:zlib";

import { Module, Port, Provider } from "@btravstack/di";
import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import {
  createHttpClient,
  httpClientFetch,
  HttpClient,
  httpClient,
  type HttpPolicy,
} from "./index.js";

describe("outbound HTTPS", () => {
  it("reads the complete streamed body with verified TLS hostname and SNI", async ({ network }) => {
    // GIVEN
    network.respond = (_req, res) => {
      res.write("hel");
      res.end("lo");
    };
    // WHEN
    const result = await network
      .client()
      .request({ url: network.origin + "/path", headers: { authorization: "Bearer secret" } });
    // THEN
    expect(
      result.map((response) => ({
        status: response.status,
        body: Buffer.from(response.body).toString(),
        request: network.requests[0],
      })),
    ).toBeOkWith({
      status: 200,
      body: "hello",
      request: {
        url: "/path",
        authorization: "Bearer secret",
        host: new URL(network.origin).host,
        sni: "api.example",
        body: "",
      },
    });
  });
  it.for([
    ["127.0.0.1"],
    ["8.8.8.8", "10.0.0.1"],
    ["::ffff:127.0.0.1"],
    ["2606:4700::1111", "fe80::1"],
  ])("refuses complete mixed DNS answer %j", async (addresses, { network }) => {
    // GIVEN
    network.addresses = addresses;
    // WHEN
    const result = await network.client().request({ url: network.origin });
    // THEN
    expect(result).toBeErrTagged("HttpDestinationForbidden");
  });
  it("checks DNS again on the next operation rather than reusing a connection", async ({
    network,
  }) => {
    // GIVEN
    const client = network.client();
    await client.request({ url: network.origin });
    network.addresses = ["127.0.0.1"];
    // WHEN
    const result = await client.request({ url: network.origin });
    // THEN
    expect(result).toBeErrTagged("HttpDestinationForbidden");
  });
  it.for([300, 301, 302, 303, 305, 306, 307, 308, 399])(
    "refuses redirect %s",
    async (status, { network }) => {
      // GIVEN
      network.respond = (_req, res) => {
        res.writeHead(status, { location: "https://127.0.0.1/secret" });
        res.end();
      };
      // WHEN
      const result = await network.client().request({ url: network.origin });
      // THEN
      expect(result).toBeErrWith(expect.objectContaining({ _tag: "HttpRedirectRefused", status }));
    },
  );
  it("bounds streamed chunked bytes without Content-Length", async ({ network }) => {
    // GIVEN
    network.respond = (_req, res) => {
      res.write("123");
      res.end("456");
    };
    // WHEN
    const result = await network.client({ maxResponseBytes: 5 }).request({ url: network.origin });
    // THEN
    expect(result).toBeErrTagged("HttpResponseTooLarge");
  });
  it("refuses compressed bodies before any decoding", async ({ network }) => {
    // GIVEN
    network.respond = (_req, res) => {
      res.writeHead(200, { "content-encoding": "gzip" });
      res.end(gzipSync(Buffer.alloc(1_000_000)));
    };
    // WHEN
    const result = await network.client().request({ url: network.origin });
    // THEN
    expect(result).toBeErrTagged("HttpEncodingRefused");
  });
  it("refuses an untrusted TLS certificate", async ({ network }) => {
    // GIVEN
    network.trusted = false;
    // WHEN
    const result = await network.client().request({ url: network.origin });
    // THEN
    expect(result).toBeErrTagged("HttpUnavailable");
  });
  it.for(["headers", "body", "dns"] as const)(
    "deadline destroys unfinished %s operation",
    async (phase, { network }) => {
      // GIVEN
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      network.lookupNever = phase === "dns";
      network.respond = (_req, res) => {
        if (phase === "body") res.write("partial");
      };
      const pending = network.client().request({ url: network.origin });
      if (phase !== "dns") await vi.waitUntil(() => network.requests.length === 1);
      // WHEN
      await vi.advanceTimersByTimeAsync(1001);
      const result = await pending;
      vi.useRealTimers();
      // THEN
      expect(result).toBeErrTagged("HttpDeadlineExceeded");
    },
  );
  it("caller cancellation destroys a pending response", async ({ network }) => {
    // GIVEN
    network.respond = (_req, res) => {
      res.write("partial");
    };
    const controller = new AbortController();
    const pending = network.client().request({ url: network.origin, signal: controller.signal });
    await vi.waitUntil(() => network.requests.length === 1);
    // WHEN
    controller.abort();
    const result = await pending;
    await vi.waitUntil(() => network.closed > 0);
    // THEN
    expect({ cancelled: result.isErr() && result.error._tag, closed: network.closed > 0 }).toEqual({
      cancelled: "HttpCancelled",
      closed: true,
    });
  });
  it("maps an already cancelled request", async ({ network }) => {
    // GIVEN
    const signal = AbortSignal.abort();
    // WHEN
    const result = await network.client().request({ url: network.origin, signal });
    // THEN
    expect(result).toBeErrTagged("HttpCancelled");
  });
  it.for([[], ["8.8.8.8"]])(
    "maps DNS failure or empty DNS answers %j",
    async (addresses, { network }) => {
      // GIVEN
      network.addresses = addresses;
      if (addresses.length) network.dnsError = new Error("secret diagnostic");
      // WHEN
      const result = await network.client().request({ url: network.origin });
      // THEN
      expect(result).toBeErrTagged("HttpUnavailable");
    },
  );
  it("maps truncated response framing", async ({ network }) => {
    // GIVEN
    network.respond = (_req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("short");
      res.socket!.destroy();
    };
    // WHEN
    const result = await network.client().request({ url: network.origin });
    // THEN
    expect(result).toBeErrTagged("HttpUnavailable");
  });
  it("adapts form requests and no-body responses for OAuth", async ({ network }) => {
    // GIVEN
    network.respond = (_req, res) => {
      res.writeHead(204);
      res.end();
    };
    const fetch = httpClientFetch(network.client());
    // WHEN
    const response = await fetch(network.origin, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    // THEN
    expect({
      status: response.status,
      body: await response.text(),
      sent: network.requests[0]!.body,
    }).toEqual({ status: 204, body: "", sent: "grant_type=client_credentials" });
  });
});

describe("bounded complete responses", () => {
  it("counts UTF-8 bytes and permits an exactly full body", async ({ network }) => {
    // GIVEN
    network.respond = (_req, res) => {
      res.setHeader("content-encoding", "identity");
      res.setHeader("set-cookie", ["a=1", "b=2"]);
      res.end("éé");
    };
    // WHEN
    const result = await network.client({ maxResponseBytes: 4 }).request({ url: network.origin });
    // THEN
    expect(
      result.map(({ body, headers }) => ({ bytes: body.length, cookies: headers["set-cookie"] })),
    ).toBeOkWith({ bytes: 4, cookies: "a=1, b=2" });
  });
  it("snapshots the policy and request before asynchronous work", async ({ network }) => {
    // GIVEN
    const policy = { origins: [network.origin], deadlineMs: 1000, maxResponseBytes: 5 };
    const client = createHttpClient(policy).getOrThrow();
    const headers = { authorization: "Bearer original" };
    const body = new Uint8Array([65]);
    // WHEN
    const pending = client.request({ url: network.origin, method: "POST", headers, body });
    policy.origins[0] = "https://evil.example";
    policy.maxResponseBytes = 1;
    headers.authorization = "Bearer changed";
    body[0] = 66;
    const result = await pending;
    // THEN
    expect(
      result.map(() => ({
        authorization: network.requests[0]!.authorization,
        body: network.requests[0]!.body,
      })),
    ).toBeOkWith({ authorization: "Bearer original", body: "A" });
  });
});

describe("connection boundaries", () => {
  it("connects to the checked DNS answer without a second rebinding lookup", async ({
    network,
  }) => {
    // GIVEN
    network.rebound = true;
    // WHEN
    const result = await network.client().request({ url: network.origin });
    // THEN
    expect(result.map(() => network.lookups)).toBeOkWith(1);
  });
  it("verifies the original hostname rather than the checked IP", async ({ network }) => {
    // GIVEN
    network.origin = network.origin.replace("api.example", "other.example");
    // WHEN
    const result = await network.client().request({ url: network.origin });
    // THEN
    expect(result).toBeErrTagged("HttpUnavailable");
  });
  it("ignores proxy environment configuration on its direct transport", async ({ network }) => {
    // GIVEN
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:1");
    vi.stubEnv("NODE_USE_ENV_PROXY", "1");
    // WHEN
    const result = await network.client().request({ url: network.origin });
    // THEN
    expect(result.map(({ status }) => status)).toBeOkWith(200);
  });
  it("deadline destroys a socket stuck in the TLS handshake", async ({ network, blackhole }) => {
    // GIVEN
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    network.origin = blackhole.origin;
    const client = network.client();
    const pending = client.request({ url: blackhole.origin });
    await vi.waitUntil(() => blackhole.sockets.size === 1);
    // WHEN
    await vi.advanceTimersByTimeAsync(1001);
    const result = await pending;
    vi.useRealTimers();
    await vi.waitUntil(() => blackhole.sockets.size === 0);
    // THEN
    expect({ tag: result.isErr() && result.error._tag, open: blackhole.sockets.size }).toEqual({
      tag: "HttpDeadlineExceeded",
      open: 0,
    });
  });
});

describe("injected request ownership", () => {
  it("captures URL, headers and body before observers defer the request", async ({ network }) => {
    // GIVEN
    class Policy extends Port("InjectedHttpPolicy")<HttpPolicy> {}
    const root = Module("InjectedHttp")({
      imports: [httpClient(Policy)],
      provides: [
        Provider(Policy)({
          inject: {},
          value: { origins: [network.origin], maxResponseBytes: 100, deadlineMs: 1000 },
        }),
      ],
      exports: [HttpClient],
    });
    // WHEN
    const result = await Module.scoped(root, (ctx) => {
      const url = new URL(network.origin + "/original");
      const headers = { authorization: "Bearer original" };
      const body = new Uint8Array([65]);
      const pending = ctx.get(HttpClient).request({ url, method: "POST", headers, body });
      url.pathname = "/changed";
      headers.authorization = "Bearer changed";
      body[0] = 66;
      return pending.map(() => network.requests[0]);
    });
    // THEN
    expect(result).toBeOkWith(
      expect.objectContaining({ url: "/original", authorization: "Bearer original", body: "A" }),
    );
  });
});

describe("fetch response and body compatibility", () => {
  it("preserves a conditional 304 response as an empty response", async ({ network }) => {
    // GIVEN
    network.respond = (_req, res) => {
      res.writeHead(304, { etag: '"version"' });
      res.end();
    };
    const fetch = httpClientFetch(network.client());
    // WHEN
    const response = await fetch(network.origin, { headers: { "if-none-match": '"version"' } });
    // THEN
    expect({
      status: response.status,
      etag: response.headers.get("etag"),
      body: await response.text(),
    }).toEqual({ status: 304, etag: '"version"', body: "" });
  });
  it.for([
    { body: "hello", want: "text/plain;charset=UTF-8" },
    {
      body: new URLSearchParams({ grant_type: "client_credentials" }),
      want: "application/x-www-form-urlencoded;charset=UTF-8",
    },
    { body: new Uint8Array([65]), want: "none" },
    { body: null, want: "none" },
  ])(
    "defaults Content-Type only for typed fetch bodies: $want",
    async ({ body, want }, { network }) => {
      // GIVEN
      network.respond = (req, res) => {
        res.end(req.headers["content-type"] ?? "none");
      };
      const fetch = httpClientFetch(network.client());
      // WHEN
      const response = await fetch(network.origin, { method: "POST", body });
      // THEN
      expect(await response.text()).toBe(want);
    },
  );
  it.for(["hello", new URLSearchParams({ value: "1" })])(
    "preserves caller Content-Type",
    async (body, { network }) => {
      // GIVEN
      network.respond = (req, res) => {
        res.end(req.headers["content-type"] ?? "none");
      };
      const fetch = httpClientFetch(network.client());
      // WHEN
      const response = await fetch(network.origin, {
        method: "POST",
        body,
        headers: { "Content-Type": "application/custom" },
      });
      // THEN
      expect(await response.text()).toBe("application/custom");
    },
  );
});
