import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, sep } from "node:path";

import type { ConfigInvalid } from "@btravstack/config";
import { Module, Port, Provider } from "@btravstack/di";
import {
  TEMPORAL_TLS_FILES,
  mountTemporalSecret,
} from "@btravstack/internal-test-infra/temporal-tls-files";
import { temporalEnvironment, type TemporalEnvironment } from "@btravstack/temporal-testing";
import { Connection } from "@temporalio/client";
import { ErrAsync, Ok, OkAsync, fromSafePromise, type Result, type AsyncResult } from "unthrown";
import { expect, inject, test, vi } from "vitest";

import {
  connectionOptions,
  type Credentials,
  type TemporalConnectionSecurity,
} from "../connection-security.js";
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
  readonly coherentCredentials: {
    readonly security: TemporalConnectionSecurity;
    readonly namespace: string;
    readonly arm: (removePrevious: boolean) => Promise<void>;
    readonly churn: () => Promise<void>;
    readonly swaps: () => number;
    readonly install: (pair: { readonly cert: string; readonly key: string }) => Promise<void>;
    readonly inspect: (credentials: Credentials) => AsyncResult<
      {
        readonly certificateCurrent: boolean;
        readonly keyCurrent: boolean;
        readonly swaps: number;
      },
      never
    >;
    readonly connect: (credentials: Credentials) => AsyncResult<string | undefined, never>;
    readonly own: (stop: () => PromiseLike<unknown>) => void;
  };
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
  coherentCredentials: async ({ temporal }, use) => {
    const mounted = await mountTemporalSecret();
    const security: TemporalConnectionSecurity = {
      tls: true,
      serverCaCertPath: TEMPORAL_TLS_FILES.ca,
      serverName: TEMPORAL_TLS_FILES.serverName,
      clientCertPath: mounted.cert,
      clientKeyPath: mounted.key,
      credentialsReloadMs: 10,
    };
    const address = inject("__BTRAVSTACK_TEMPORAL_TLS_ADDRESS__");
    const namespace = temporal.TEMPORAL_NAMESPACE;
    const directory = dirname(mounted.cert);
    const resolvedDirectory = await fs.realpath(directory);
    const originalRead = fs.readFile;
    const owned = new Set<Connection>();
    const stopping: (() => PromiseLike<unknown>)[] = [];
    let armed = false;
    let repeated = false;
    let holding = false;
    let removePrevious = false;
    let swaps = 0;
    let release: () => void = () => undefined;
    let swapped: Promise<void> = Promise.resolve();
    const reading = vi.spyOn(fs, "readFile").mockImplementation((path, options) => {
      if (
        typeof path !== "string" ||
        ![directory, resolvedDirectory].some((prefix) => path.startsWith(`${prefix}${sep}`))
      )
        return originalRead(path, options);
      if (armed && basename(path) === "client-cert.pem") {
        armed = repeated;
        holding = true;
        swapped = new Promise<void>((resolve) => {
          release = resolve;
        });
        const releaseReading = release;
        return originalRead(path, options)
          .then(async (bytes) => {
            const previous = dirname(await fs.realpath(path));
            await mounted.publish({ pair: TEMPORAL_TLS_FILES.client });
            swaps++;
            if (removePrevious) await fs.rm(previous, { recursive: true });
            return bytes;
          })
          .finally(releaseReading);
      }
      return holding && basename(path) === "client-key.pem"
        ? swapped.then(() => originalRead(path, options))
        : originalRead(path, options);
    });
    syncBuiltinESMExports();
    await use({
      security,
      namespace,
      arm: async (remove) => {
        await mounted.publish({ pair: TEMPORAL_TLS_FILES.rotated });
        removePrevious = remove;
        repeated = false;
        armed = true;
      },
      churn: async () => {
        await mounted.publish({ pair: TEMPORAL_TLS_FILES.rotated });
        repeated = true;
        armed = true;
      },
      swaps: () => swaps,
      install: (pair) => mounted.publish({ pair }),
      inspect: (credentials) =>
        fromSafePromise(
          Promise.all([
            originalRead(TEMPORAL_TLS_FILES.client.cert),
            originalRead(TEMPORAL_TLS_FILES.client.key),
          ]),
        ).map(([certificate, key]) => ({
          certificateCurrent: Buffer.from(credentials.tls?.clientCertPair?.crt ?? []).equals(
            certificate,
          ),
          keyCurrent: Buffer.from(credentials.tls?.clientCertPair?.key ?? []).equals(key),
          swaps,
        })),
      connect: (credentials) =>
        (() => {
          const connection = Connection.lazy({ address, ...connectionOptions(credentials) });
          owned.add(connection);
          return fromSafePromise(connection.ensureConnected())
            .flatMap(() =>
              fromSafePromise(connection.workflowService.describeNamespace({ namespace })),
            )
            .flatTap(() => fromSafePromise(connection.close()).tap(() => owned.delete(connection)))
            .map((response) => response.namespaceInfo?.name ?? undefined);
        })(),
      own: (stop) => {
        stopping.push(stop);
      },
    });
    release();
    await Promise.all(stopping.map((stop) => stop()));
    reading.mockRestore();
    syncBuiltinESMExports();
    for (const connection of owned) await connection.close();
    await mounted.remove();
  },

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
