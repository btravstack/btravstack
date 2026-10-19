import type { TLSSocket } from "node:tls";
import { inspect } from "node:util";

import { Observers } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { createHttpClient, httpClient, HttpClient, type HttpPolicy } from "./index.js";

describe("application-owned TLS identities", () => {
  it("presents a verified client certificate and rotates credentials on the same client", async ({
    network,
  }) => {
    // GIVEN
    let identity = network.identity;
    network.respond = (req, res) => {
      const socket = req.socket as TLSSocket;
      res.end(
        JSON.stringify({
          authorized: socket.authorized,
          name: socket.getPeerCertificate().subject.CN,
        }),
      );
    };
    const binding = { origin: network.origin, credentials: () => identity };
    const policy = {
      origins: [network.origin],
      maxResponseBytes: 1024,
      deadlineMs: 1000,
      tlsIdentities: [binding],
    };
    const client = createHttpClient(policy).getOrThrow();
    const original = await client.request({ url: network.origin });
    // WHEN
    identity = network.rotatedIdentity;
    binding.origin = "https://evil.example";
    binding.credentials = () => network.identity;
    policy.tlsIdentities.length = 0;
    const rotated = await client.request({ url: network.origin });
    // THEN
    expect(
      [original, rotated].map((result) =>
        result.map(({ body }) => JSON.parse(Buffer.from(body).toString())),
      ),
    ).toEqual([
      expect.objectContaining({ value: { authorized: true, name: "account-original" } }),
      expect.objectContaining({ value: { authorized: true, name: "account-rotated" } }),
    ]);
  });
  it.for(["untrusted", "hostname"] as const)(
    "keeps server verification mandatory: %s",
    async (mode, { network }) => {
      // GIVEN
      if (mode === "untrusted") network.trusted = false;
      else network.origin = network.origin.replace("api.example", "other.example");
      const client = createHttpClient({
        origins: [network.origin],
        maxResponseBytes: 100,
        deadlineMs: 1000,
        tlsIdentities: [{ origin: network.origin, credentials: () => network.identity }],
      }).getOrThrow();
      // WHEN
      const result = await client.request({ url: network.origin });
      // THEN
      expect(result).toBeErrTagged("HttpUnavailable");
    },
  );
  it("never reads credentials or opens a connection for an unapproved origin", async ({
    network,
  }) => {
    // GIVEN
    const credentials = vi.fn(() => network.identity);
    const client = createHttpClient({
      origins: [network.origin],
      maxResponseBytes: 100,
      deadlineMs: 1000,
      tlsIdentities: [{ origin: network.origin, credentials }],
    }).getOrThrow();
    // WHEN
    const result = await client.request({
      url: network.origin.replace("api.example", "evil.example"),
    });
    // THEN
    expect({
      tag: result.isErr() && result.error._tag,
      reads: credentials.mock.calls.length,
      connections: network.lookups,
    }).toEqual({ tag: "HttpPolicyRejected", reads: 0, connections: 0 });
  });
  it("does not send an identity to another approved origin without a binding", async ({
    network,
  }) => {
    // GIVEN
    network.respond = (req, res) =>
      res.end(JSON.stringify((req.socket as TLSSocket).getPeerCertificate()));
    const client = createHttpClient({
      origins: [network.origin, "https://bound.example"],
      maxResponseBytes: 100,
      deadlineMs: 1000,
      tlsIdentities: [{ origin: "https://bound.example", credentials: () => network.identity }],
    }).getOrThrow();
    // WHEN
    const result = await client.request({ url: network.origin });
    // THEN
    expect(result.map(({ body }) => Buffer.from(body).toString())).toBeOkWith("{}");
  });
  it("does not forward a client identity along a redirect, even to an approved origin", async ({
    network,
  }) => {
    // GIVEN
    const target = network.origin.replace("api.example", "other.example");
    network.respond = (_req, res) => {
      res.writeHead(302, { location: target });
      res.end();
    };
    const credentials = vi.fn(() => network.identity);
    const client = createHttpClient({
      origins: [network.origin, target],
      maxResponseBytes: 100,
      deadlineMs: 1000,
      tlsIdentities: [{ origin: network.origin, credentials }],
    }).getOrThrow();
    // WHEN
    const result = await client.request({ url: network.origin });
    // THEN
    expect({
      tag: result.isErr() && result.error._tag,
      reads: credentials.mock.calls.length,
      requests: network.requests.length,
    }).toEqual({ tag: "HttpRedirectRefused", reads: 1, requests: 1 });
  });
  it.for(["pem", "source"] as const)(
    "redacts %s failures from Results and observer diagnostics",
    async (mode, { network }) => {
      // GIVEN
      class Policy extends Port(`TlsPolicy-${mode}`)<HttpPolicy> {}
      const events: unknown[] = [];
      const root = Module("TlsClient")({
        imports: [httpClient(Policy)],
        provides: [
          Provider(Policy)({
            inject: {},
            value: {
              origins: [network.origin],
              maxResponseBytes: 100,
              deadlineMs: 1000,
              tlsIdentities: [
                {
                  origin: network.origin,
                  credentials: () => {
                    if (mode === "source") {
                      // oxlint-disable-next-line unthrown/no-throw -- Secret-store failure is the boundary under test.
                      throw new Error(network.identity.key);
                    }
                    return {
                      cert: "private certificate diagnostic",
                      key: "private key diagnostic",
                      passphrase: "private passphrase",
                    };
                  },
                },
              ],
            },
          }),
          Provider.member(Observers)({
            inject: {},
            value: (operation) => {
              events.push(operation);
              return (outcome) => {
                events.push(outcome);
              };
            },
          }),
        ],
        exports: [HttpClient],
      });
      // WHEN
      const result = await Module.scoped(root, (ctx) =>
        ctx.get(HttpClient).request({ url: network.origin }),
      );
      // THEN
      expect({
        tag: result.isErr() && result.error._tag,
        diagnostics: inspect({ result, events }, { depth: null }),
      }).toEqual({
        tag: "HttpUnavailable",
        diagnostics: expect.not.stringMatching(
          /PRIVATE KEY|private certificate|private key|private passphrase/,
        ),
      });
    },
  );
  it.for([
    { cert: "", key: "key" },
    { cert: "cert", key: "" },
    { cert: "cert", key: "key", passphrase: 123 },
    undefined,
  ])("fails closed for incomplete credential snapshots %j", async (identity, { network }) => {
    // GIVEN
    const client = createHttpClient({
      origins: [network.origin],
      maxResponseBytes: 100,
      deadlineMs: 1000,
      tlsIdentities: [
        {
          origin: network.origin,
          credentials: () => identity as unknown as import("./index.js").HttpTlsIdentity,
        },
      ],
    }).getOrThrow();
    // WHEN
    const result = await client.request({ url: network.origin });
    // THEN
    expect({ tag: result.isErr() && result.error._tag, connections: network.lookups }).toEqual({
      tag: "HttpUnavailable",
      connections: 0,
    });
  });
  it("ignores request-supplied TLS overrides at runtime", async ({ network }) => {
    // GIVEN
    const client = createHttpClient({
      origins: [network.origin],
      maxResponseBytes: 100,
      deadlineMs: 1000,
      tlsIdentities: [{ origin: network.origin, credentials: () => network.identity }],
    }).getOrThrow();
    network.trusted = false;
    const request = {
      url: network.origin,
      rejectUnauthorized: false,
      cert: network.rotatedIdentity.cert,
      key: network.rotatedIdentity.key,
      checkServerIdentity: () => undefined,
    };
    // WHEN
    const result = await client.request(request);
    // THEN
    expect(result).toBeErrTagged("HttpUnavailable");
  });
  it("keeps the bound identity when request input contains other credentials", async ({
    network,
  }) => {
    // GIVEN
    network.respond = (req, res) =>
      res.end((req.socket as TLSSocket).getPeerCertificate().subject.CN);
    const client = createHttpClient({
      origins: [network.origin],
      maxResponseBytes: 100,
      deadlineMs: 1000,
      tlsIdentities: [{ origin: network.origin, credentials: () => network.identity }],
    }).getOrThrow();
    const request = { url: network.origin, ...network.rotatedIdentity };
    // WHEN
    const result = await client.request(request);
    // THEN
    expect(result.map(({ body }) => Buffer.from(body).toString())).toBeOkWith("account-original");
  });
  it.for(["unapproved", "path", "duplicate", "source", "invalid"] as const)(
    "refuses invalid identity binding: %s",
    (mode, { network }) => {
      // GIVEN
      const binding = {
        origin:
          mode === "invalid"
            ? "invalid"
            : mode === "unapproved"
              ? "https://evil.example"
              : network.origin + (mode === "path" ? "/path" : ""),
        credentials: mode === "source" ? undefined! : () => network.identity,
      };
      // WHEN
      const result = createHttpClient({
        origins: [network.origin],
        maxResponseBytes: 100,
        deadlineMs: 1000,
        tlsIdentities: mode === "duplicate" ? [binding, binding] : [binding],
      });
      // THEN
      expect(result).toBeErrWith(
        expect.objectContaining({ _tag: "HttpPolicyInvalid", field: "tlsIdentities" }),
      );
    },
  );
});
