import type { ConfigInvalid } from "@btravstack/config";
import { Module, Port, Provider } from "@btravstack/di";
import {
  TEMPORAL_TLS_FILES,
  mountTemporalSecret,
} from "@btravstack/internal-test-infra/temporal-tls-files";
import { temporalEnvironment, type TemporalEnvironment } from "@btravstack/temporal-testing";
import type { Connection } from "@temporalio/client";
import { Err, Ok, fromSafePromise, type Result } from "unthrown";
import { inject, test } from "vitest";

import {
  temporalConnection,
  type TemporalClientSettings,
  type TemporalClientUnreachable,
} from "../index.js";

class Settings extends Port("SecuredSettings")<TemporalClientSettings> {}
class ConnectionPort extends Port("SecuredConnection")<Connection> {}

/** A connection held open until the test ends, or why it could not be opened. */
type Opened = Result<Connection, TemporalClientUnreachable | ConfigInvalid>;

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
  readonly open: (settings: TemporalClientSettings) => Promise<Opened>;
};

export const it = test.extend<ClientFixtures>({
  temporal: temporalEnvironment("temporal-client"),
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
      (settings) =>
        new Promise<Opened>((answer) => {
          let release!: () => void;
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          const scope = Module.scoped(
            Module("SecuredClient")({
              provides: [
                Provider(Settings)({ inject: {}, value: settings }),
                temporalConnection(ConnectionPort, Settings),
              ],
              exports: [ConnectionPort],
            }),
            (ctx) => {
              answer(Ok(ctx.get(ConnectionPort)));
              return fromSafePromise(held);
            },
          );
          releases.push(async () => {
            release();
            await scope;
          });
          // A scope that could not open answers its failure; one that did has answered already.
          void scope.then((closed) => closed.isErr() && answer(Err(closed.error)));
        }),
    );
    for (const release of releases) await release();
  },
});
