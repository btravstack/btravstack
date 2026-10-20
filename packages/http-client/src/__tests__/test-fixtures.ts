import dns from "node:dns";
import { readFileSync } from "node:fs";
import https from "node:https";
import { createServer, type LookupFunction, type Socket } from "node:net";

import { test, vi } from "vitest";

import { createHttpClient } from "../index.js";

export const it = test.extend<{
  mutualTls: boolean;
  blackhole: { origin: string; sockets: Set<Socket> };
  network: {
    origin: string;
    addresses: string[];
    lookups: number;
    rebound: boolean;
    dnsError: Error | undefined;
    lookupNever: boolean;
    trusted: boolean;
    closed: number;
    identity: import("../index.js").HttpTlsIdentity;
    rotatedIdentity: import("../index.js").HttpTlsIdentity;
    requests: {
      url: string;
      authorization: string | undefined;
      host: string | undefined;
      sni: string | undefined;
      body: string;
    }[];
    respond: (
      req: import("node:http").IncomingMessage,
      res: import("node:http").ServerResponse,
    ) => void;
    client: (limits?: {
      maxResponseBytes?: number;
      deadlineMs?: number;
    }) => ReturnType<typeof createHttpClient> extends import("unthrown").Result<infer T, unknown>
      ? T
      : never;
  };
}>({
  mutualTls: false,
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructured context.
  blackhole: async ({}, use) => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      socket.resume();
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as import("node:net").AddressInfo;
    await use({ origin: `https://api.example:${port}`, sockets });
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  },
  network: async ({ mutualTls }, use) => {
    const cert = readFileSync(new URL("cert.pem", import.meta.url));
    const key = readFileSync(new URL("key.pem", import.meta.url));
    const requests: {
      url: string;
      authorization: string | undefined;
      host: string | undefined;
      sni: string | undefined;
      body: string;
    }[] = [];
    const state = {
      origin: "",
      addresses: ["8.8.8.8"],
      lookups: 0,
      rebound: false,
      dnsError: undefined as Error | undefined,
      lookupNever: false,
      trusted: true,
      requests,
      closed: 0,
      identity: {
        cert: readFileSync(new URL("client-cert.pem", import.meta.url), "utf8"),
        key: readFileSync(new URL("client-key.pem", import.meta.url), "utf8"),
      },
      rotatedIdentity: {
        cert: readFileSync(new URL("rotated-cert.pem", import.meta.url), "utf8"),
        key: readFileSync(new URL("rotated-key.pem", import.meta.url), "utf8"),
        passphrase: "test-only-rotation",
      },
      respond: (
        _req: import("node:http").IncomingMessage,
        res: import("node:http").ServerResponse,
      ) => {
        res.end("hello");
      },
      client: (limits: { maxResponseBytes?: number; deadlineMs?: number } = {}) =>
        createHttpClient({
          origins: [state.origin],
          maxResponseBytes: limits.maxResponseBytes ?? 1024,
          deadlineMs: limits.deadlineMs ?? 30_000,
        }).getOrThrow(),
    };
    const server = https.createServer(
      { key, cert, ca: cert, requestCert: mutualTls, rejectUnauthorized: true },
      (req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          requests.push({
            url: req.url!,
            authorization: req.headers.authorization,
            host: req.headers.host,
            sni: (req.socket as import("node:tls").TLSSocket).servername || undefined,
            body,
          });
          state.respond(req, res);
        });
      },
    );
    server.on("connection", (socket) => {
      socket.on("close", () => {
        state.closed++;
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as import("node:net").AddressInfo;
    state.origin = `https://api.example:${port}`;
    vi.spyOn(dns, "lookup").mockImplementation(((
      _host: string,
      _options: unknown,
      callback: (error: Error | null, addresses: dns.LookupAddress[]) => void,
    ) => {
      state.lookups++;
      if (!state.lookupNever)
        callback(
          state.dnsError ?? null,
          state.addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
        );
      if (state.rebound) state.addresses = ["127.0.0.1"];
    }) as typeof dns.lookup);
    const realRequest = https.request;
    vi.spyOn(https, "request").mockImplementation(((
      url: URL,
      options: https.RequestOptions,
      callback: (res: import("node:http").IncomingMessage) => void,
    ) => {
      const guarded = options.lookup!;
      const lookup: LookupFunction = (host, lookupOptions, done) =>
        guarded(host, lookupOptions, (error, _address, _family) => done(error, "127.0.0.1", 4));
      return realRequest(
        url,
        { ...options, lookup, ...(state.trusted ? { ca: cert } : {}) },
        callback,
      );
    }) as typeof https.request);
    await use(state);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  },
});

export const mtlsIt = it.extend({ mutualTls: true });
