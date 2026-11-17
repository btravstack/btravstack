import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, sep } from "node:path";

import { Env, type ConfigInvalid, type Environment } from "@btravstack/config";
import {
  HealthChecks,
  Observers,
  runHealthChecks,
  type HealthReport,
  type Operation,
  type Settle,
  type Settled,
} from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import {
  TEMPORAL_TLS_FILES,
  mountTemporalSecret,
} from "@btravstack/internal-test-infra/temporal-tls-files";
import { temporalEnvironment, type TemporalEnvironment } from "@btravstack/temporal-testing";
import type { TypedClient } from "@temporal-contract/client";
import { Connection } from "@temporalio/client";
import type { DataConverter } from "@temporalio/common";
import { ErrAsync, Ok, OkAsync, fromSafePromise, type Result, type AsyncResult } from "unthrown";
import { expect, inject, test, vi, type MockInstance } from "vitest";

import {
  connectionOptions,
  type Credentials,
  type TemporalConnectionSecurity,
} from "../connection-security.js";
import {
  temporalClient,
  type TemporalClientOptions,
  type TemporalClientUnreachable,
  TemporalApiKeyUnavailable,
  type TemporalApiKeySource,
} from "../index.js";

export class ClientPort extends Port("SecuredClient")<TypedClient> {}
class ApiKeySource extends Port("TestTemporalApiKeySource")<TemporalApiKeySource> {}
class ConverterPort extends Port("TestTemporalConverter")<DataConverter> {}

/** The environment a client deployment sets: the service, its namespace, and anything else. */
export type ClientEnvironment = TemporalEnvironment & Environment;

/** A client open until the test ends. */
export type Opened = {
  /** The connection the typed client calls through. */
  readonly connection: Connection;
  readonly client: TypedClient;
  /** The graph's health checks, as the kernel folds them. */
  readonly health: () => AsyncResult<HealthReport, never>;
  /** Closes the client's scope before the test ends. */
  readonly close: () => Promise<void>;
};

/** What {@link ClientFixtures.open} composes beside the environment. */
export type OpenOptions = Pick<TemporalClientOptions, "address" | "namespace"> & {
  readonly source?: TemporalApiKeySource;
  readonly converter?: DataConverter;
};

/** One operation an observer was handed, with how it settled. */
export type Observation = {
  readonly operation: Operation;
  settled?: Settled;
};

/** A client held open until the test ends, or why it could not be opened. */
type Opening = Result<
  Opened,
  TemporalClientUnreachable | ConfigInvalid | TemporalApiKeyUnavailable
>;

/** What {@link ClientFixtures.secured} hands a spec. */
export type Secured = {
  /** An environment presenting the mounted client certificate to the proxy requiring one. */
  readonly mtls: ClientEnvironment;
  /** An environment sending the mounted API key to the proxy requiring one. */
  readonly apiKey: ClientEnvironment;
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
  /** Opens `temporalClient` over `env`, in a scope closed when the test ends. */
  readonly open: (env: Environment, options?: OpenOptions) => Promise<Opening>;
  /** Every operation the client reported, in order. */
  readonly observations: Observation[];
  /**
   * A gRPC server of the test's own that admits a connection (it answers
   * `GetSystemInfo` as an older server does) and answers the health check
   * with `status`, until it is stopped.
   */
  readonly scripted: {
    readonly env: ClientEnvironment;
    readonly answer: (status: number) => void;
    readonly stop: () => Promise<void>;
  };
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
    readonly env: ClientEnvironment;
    readonly attempt: () => Promise<Opening>;
    readonly requests: () => number;
    readonly activeSessions: () => number;
  };
  /** `Connection.lazy` answering a connection that opens and closes without a server. */
  readonly fake: {
    readonly connection: Connection;
    readonly closes: () => number;
    readonly lazy: MockInstance<typeof Connection.lazy>;
  };
  readonly failedCleanup: {
    readonly initialization: Error;
    readonly cleanup: Error;
    readonly attempt: () => Promise<Opening>;
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
  // oxlint-disable-next-line no-empty-pattern -- this fixture has no infrastructure dependency
  fake: async ({}, use) => {
    const close = vi.fn(() => Promise.resolve());
    const connection = { close, ensureConnected: () => Promise.resolve() } as unknown as Connection;
    const lazy = vi.spyOn(Connection, "lazy").mockReturnValue(connection);
    await use({ connection, closes: () => close.mock.calls.length, lazy });
    lazy.mockRestore();
  },
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
      attempt: () => open({ TEMPORAL_ADDRESS: "unavailable:7233", TEMPORAL_NAMESPACE: "orders" }),
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
    const env = { TEMPORAL_ADDRESS: address, TEMPORAL_NAMESPACE: "refused" };
    await use({
      env,
      attempt: () => open(env),
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
      TEMPORAL_NAMESPACE: temporal.TEMPORAL_NAMESPACE,
      TEMPORAL_TLS: "true",
      TEMPORAL_TLS_SERVER_CA_CERT_PATH: TEMPORAL_TLS_FILES.ca,
      TEMPORAL_TLS_SERVER_NAME: TEMPORAL_TLS_FILES.serverName,
      TEMPORAL_CREDENTIALS_RELOAD_MS: "10",
    };
    await use({
      mtls: {
        ...tls,
        TEMPORAL_ADDRESS: inject("__BTRAVSTACK_TEMPORAL_TLS_ADDRESS__"),
        TEMPORAL_TLS_CLIENT_CERT_PATH: mounted.cert,
        TEMPORAL_TLS_CLIENT_KEY_PATH: mounted.key,
      },
      apiKey: {
        ...tls,
        TEMPORAL_ADDRESS: inject("__BTRAVSTACK_TEMPORAL_API_KEY_ADDRESS__"),
        TEMPORAL_API_KEY_PATH: mounted.apiKey,
      },
      install: (pair) => mounted.publish({ pair }),
      writeApiKey: (apiKey) => mounted.publish({ apiKey }),
    });
    await mounted.remove();
  },
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  observations: async ({}, use) => {
    await use([]);
  },
  open: async ({ observations }, use) => {
    const recorder = (operation: Operation): Settle => {
      const observation: Observation = { operation };
      observations.push(observation);
      return (settled) => {
        observation.settled = settled;
      };
    };
    const releases: (() => Promise<unknown>)[] = [];
    await use(
      (env, { source, converter, ...pins } = {}) =>
        new Promise<Opening>((answer) => {
          let release!: () => void;
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          const scope = Module.scoped(
            Module("SecuredClient")({
              imports: [
                temporalClient(ClientPort, {
                  ...pins,
                  ...(source === undefined ? {} : { apiKey: ApiKeySource }),
                  ...(converter === undefined ? {} : { dataConverter: ConverterPort }),
                } as TemporalClientOptions),
              ],
              provides: [
                Provider(Env)({ inject: {}, value: env }),
                Provider.member(Observers)({ inject: {}, value: recorder }),
                ...(source === undefined
                  ? []
                  : [Provider(ApiKeySource)({ inject: {}, value: source })]),
                ...(converter === undefined
                  ? []
                  : [Provider(ConverterPort)({ inject: {}, value: converter })]),
              ],
              exports: [ClientPort, HealthChecks],
            } as never) as unknown as Module<
              ClientPort | HealthChecks,
              TemporalClientUnreachable | ConfigInvalid | TemporalApiKeyUnavailable,
              never
            >,
            (ctx) => {
              const client = ctx.get(ClientPort);
              const close = async (): Promise<void> => {
                release();
                await scope;
              };
              answer(
                Ok({
                  connection: client.raw.connection as Connection,
                  client,
                  health: () => runHealthChecks(ctx.get(HealthChecks)),
                  close,
                }),
              );
              return fromSafePromise(held).map(() => client);
            },
          );
          releases.push(async () => {
            release();
            await scope;
          });
          // A scope that could not open answers its failure; one that did has answered already.
          void scope.then((closed) => {
            if (!closed.isOk()) answer(closed as Result<never, never> as Opening);
          });
        }),
    );
    for (const release of releases) await release();
  },
  // oxlint-disable-next-line no-empty-pattern -- this fixture has no infrastructure dependency
  scripted: async ({}, use) => {
    const sessions = new Set<ServerHttp2Session>();
    let status = 1;
    const server = createServer();
    server.on("session", (session) => {
      sessions.add(session);
      session.on("close", () => sessions.delete(session));
    });
    server.on("stream", (stream: ServerHttp2Stream, headers) => {
      if (headers[":path"] !== "/grpc.health.v1.Health/Check") {
        stream.respond(
          { ":status": 200, "content-type": "application/grpc", "grpc-status": "12" },
          { endStream: true },
        );
        return;
      }
      stream.respond(
        { ":status": 200, "content-type": "application/grpc" },
        { waitForTrailers: true },
      );
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
      stream.end(Buffer.from([0, 0, 0, 0, 2, 0x08, status]));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const binding = server.address();
    const address =
      typeof binding === "object" && binding !== null ? `127.0.0.1:${String(binding.port)}` : "";
    const stop = async (): Promise<void> => {
      if (!server.listening) return;
      for (const session of sessions) session.destroy();
      const closed = once(server, "close");
      server.close();
      await closed;
    };
    await use({
      env: { TEMPORAL_ADDRESS: address, TEMPORAL_NAMESPACE: "scripted" },
      answer: (next) => {
        status = next;
      },
      stop,
    });
    await stop();
  },
});
