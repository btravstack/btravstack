import { once } from "node:events";
import { createServer, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";

import type { ConfigInvalid } from "@btravstack/config";
import { Module, Port, Provider } from "@btravstack/di";
import {
  TEMPORAL_TLS_FILES,
  mountTemporalSecret,
} from "@btravstack/internal-test-infra/temporal-tls-files";
import { temporalEnvironment, type TemporalEnvironment } from "@btravstack/temporal-testing";
import { Connection } from "@temporalio/client";
import { ErrAsync, Ok, OkAsync, fromSafePromise, type Result } from "unthrown";
import { expect, inject, test, vi } from "vitest";

import {
  temporalConnection,
  type TemporalClientSettings,
  type TemporalClientUnreachable,
  TemporalApiKeyUnavailable,
  type TemporalApiKeySource,
} from "../index.js";

class Settings extends Port("SecuredSettings")<TemporalClientSettings> {}
class ConnectionPort extends Port("SecuredConnection")<Connection> {}
class ApiKeySource extends Port("TestTemporalApiKeySource")<TemporalApiKeySource> {}

/** A connection held open until the test ends, or why it could not be opened. */
type Opened = Result<
  Connection,
  TemporalClientUnreachable | ConfigInvalid | TemporalApiKeyUnavailable
>;

/** What {@link ClientFixtures.secured} hands a spec. */
export type Secured = {
  /** Settings presenting the mounted client certificate to the proxy requiring one. */
  readonly mtls: TemporalClientSettings;
  /** Settings sending the mounted API key to the proxy requiring one. */
  readonly apiKey: TemporalClientSettings;
  /** Replaces the mounted client certificate and key with `pair`'s. */
  readonly install: (pair: { readonly cert: string; readonly key: string }) => Promise<void>;
  /** Replaces the mounted API key. */
  readonly writeApiKey: (value: string) => Promise<void>;
};

export type ClientFixtures = {
  /** The shared server's plaintext address and this file's namespace on it. */
  readonly temporal: TemporalEnvironment;
  /** Mounted credentials of this test's own, and settings using them through the TLS proxy. */
  readonly secured: Secured;
  /** Opens `temporalConnection` over `settings`, in a scope closed when the test ends. */
  readonly open: (
    settings: TemporalClientSettings,
    source?: TemporalApiKeySource,
  ) => Promise<Opened>;
  readonly heldSource: {
    readonly source: TemporalApiKeySource;
    readonly entered: Promise<void>;
    readonly release: () => void;
  };
  readonly renewable: {
    readonly source: TemporalApiKeySource;
    readonly set: (value: string | undefined) => void;
    readonly reads: () => number;
  };
  readonly refusing: {
    readonly settings: TemporalClientSettings;
    readonly attempt: () => Promise<Opened>;
    readonly requests: () => number;
    readonly activeSessions: () => number;
  };
  readonly failedCleanup: {
    readonly initialization: Error;
    readonly cleanup: Error;
    readonly attempt: () => Promise<Opened>;
  };
};

export const it = test.extend<ClientFixtures>({
  temporal: temporalEnvironment("temporal-client"),
  failedCleanup: async ({ open }, use) => {
    const initialization = new Error("connection refused");
    const cleanup = new Error("SDK cleanup failed");
    const allocation = vi.spyOn(Connection, "lazy").mockReturnValue({
      ensureConnected: vi.fn().mockRejectedValue(initialization),
      close: vi.fn().mockRejectedValue(cleanup),
    } as unknown as Connection);
    await use({
      initialization,
      cleanup,
      attempt: () => open({ address: "unavailable:7233", namespace: "orders" }),
    });
    allocation.mockRestore();
  },
  refusing: async ({ open }, use) => {
    const sessions = new Set<ServerHttp2Session>();
    let requests = 0;
    const server = createServer();
    server.on("session", (session) => {
      sessions.add(session);
      session.on("close", () => sessions.delete(session));
    });
    server.on("stream", (stream: ServerHttp2Stream) => {
      requests += 1;
      stream.respond(
        {
          ":status": 200,
          "content-type": "application/grpc",
          "grpc-status": "7",
          "grpc-message": "fixture refused",
        },
        { endStream: true },
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const binding = server.address();
    const address =
      typeof binding === "object" && binding !== null ? `127.0.0.1:${String(binding.port)}` : "";
    const settings = { address, namespace: "refused" };
    await use({
      settings,
      attempt: () => open(settings),
      requests: () => requests,
      activeSessions: () => sessions.size,
    });
    const drained = await vi
      .waitUntil(() => sessions.size === 0)
      .then(
        () => true,
        () => false,
      );
    for (const session of sessions) session.destroy();
    const closed = once(server, "close");
    server.close();
    await closed;
    expect(drained).toBe(true);
  },
  // oxlint-disable-next-line no-empty-pattern -- this fixture has no infrastructure dependency
  renewable: async ({}, use) => {
    let value: string | undefined = "temporal-test-first";
    let reads = 0;
    await use({
      source: {
        read: () => {
          reads += 1;
          return value === undefined ? ErrAsync(new TemporalApiKeyUnavailable()) : OkAsync(value);
        },
      },
      set: (next) => {
        value = next;
      },
      reads: () => reads,
    });
  },
  heldSource: async ({ open: _open }, use) => {
    let reads = 0;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await use({
      source: {
        read: () => {
          reads += 1;
          if (reads === 1) return OkAsync("temporal-test-first");
          entered();
          return fromSafePromise(held).map(() => "temporal-test-second");
        },
      },
      entered: enteredPromise,
      release,
    });
    release();
  },
  secured: async ({ temporal }, use) => {
    const mounted = await mountTemporalSecret();
    const tls = {
      namespace: temporal.TEMPORAL_NAMESPACE,
      tls: true,
      serverCaCertPath: TEMPORAL_TLS_FILES.ca,
      serverName: TEMPORAL_TLS_FILES.serverName,
      credentialsReloadMs: 10,
    };
    await use({
      mtls: {
        ...tls,
        address: inject("__BTRAVSTACK_TEMPORAL_TLS_ADDRESS__"),
        clientCertPath: mounted.cert,
        clientKeyPath: mounted.key,
      },
      apiKey: {
        ...tls,
        address: inject("__BTRAVSTACK_TEMPORAL_API_KEY_ADDRESS__"),
        apiKeyPath: mounted.apiKey,
      },
      install: (pair) => mounted.publish({ pair }),
      writeApiKey: (apiKey) => mounted.publish({ apiKey }),
    });
    await mounted.remove();
  },
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  open: async ({}, use) => {
    const releases: (() => Promise<unknown>)[] = [];
    await use(
      (settings, source) =>
        new Promise<Opened>((answer) => {
          let release!: () => void;
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          const scope = Module.scoped(
            Module("SecuredClient")({
              provides: [
                Provider(Settings)({ inject: {}, value: settings }),
                ...(source === undefined
                  ? []
                  : [Provider(ApiKeySource)({ inject: {}, value: source })]),
                temporalConnection(
                  ConnectionPort,
                  Settings,
                  source === undefined ? undefined : { apiKey: ApiKeySource },
                ),
              ],
              exports: [ConnectionPort],
            }),
            (ctx) => {
              const connection = ctx.get(ConnectionPort);
              answer(Ok(connection));
              return fromSafePromise(held).map(() => connection);
            },
          );
          releases.push(async () => {
            release();
            await scope;
          });
          // A scope that could not open answers its failure; one that did has answered already.
          void scope.then((closed) => {
            if (!closed.isOk()) answer(closed);
          });
        }),
    );
    for (const release of releases) await release();
  },
});
