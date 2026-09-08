import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  GenericContainer,
  Wait,
  getContainerRuntimeClient,
  type StartedTestContainer,
} from "testcontainers";

import { TEST_INFRA_LABEL, shared } from "./containers.js";
import { withLock } from "./lock.js";
import { ORY_POST_LOGOUT_URI, provisionOry } from "./ory-provision.js";

export {
  ORY_CLIENT_ID,
  ORY_CLIENT_SECRET,
  ORY_POST_LOGOUT_URI,
  ORY_REDIRECT_URI,
  ORY_SCOPE,
  ORY_USERS,
  createIdentity,
  provisionOry,
  type OryIdentity,
  type OryProvisioned,
  type OryUser,
} from "./ory-provision.js";

/**
 * A fixed name rather than testcontainers' own `Network`, which mints a random
 * one and registers it with Ryuk: a second process could neither find it nor
 * rely on it outliving the run that created it.
 */
export const ORY_NETWORK = "btravstack-ory";

/** What Hydra is started as, and therefore what a discovery document must answer. */
export const ORY_ISSUER = "http://localhost:4444/";

/**
 * Test infrastructure, not a deployment: a value nothing outside this
 * repository signs or encrypts with is a constant rather than configuration.
 * Hydra requires 32 characters.
 */
const SECRETS_SYSTEM = "youReallyNeedToChangeThis32Chars";

/**
 * Content copied into a container is copied AFTER create and is not part of
 * what testcontainers hashes for reuse — so the digest rides a label, and an
 * edited config or handler gets a new container rather than a reused one still
 * running the old copy.
 */
const CONTENT_LABEL = "com.btravstack.ory-content";

const digest = async (...files: readonly URL[]): Promise<string> => {
  const contents = await Promise.all(files.map((file) => readFile(file)));
  return createHash("sha256").update(Buffer.concat(contents)).digest("hex").slice(0, 16);
};

const ensureNetwork = (): Promise<void> =>
  withLock("ory-network", async () => {
    const client = await getContainerRuntimeClient();
    const exists = await client.network
      .getById(ORY_NETWORK)
      .inspect()
      .then(
        () => true,
        () => false,
      );
    if (exists) return;

    await client.network.create({
      Name: ORY_NETWORK,
      Driver: "bridge",
      Labels: { [TEST_INFRA_LABEL]: "ory" },
    });
  });

/**
 * The OpenID provider. Fixed host ports, because a redirect protocol needs its
 * URLs before the container exists — and because they are then identical from
 * the host and from inside a container, which is what lets `URLS_LOGIN` point
 * a browser straight at Kratos.
 */
const sharedHydra = (): Promise<StartedTestContainer> =>
  shared("ory-hydra", () =>
    new GenericContainer("oryd/hydra:v2.3.0")
      .withCommand(["serve", "all", "--dev"])
      .withNetworkMode(ORY_NETWORK)
      .withNetworkAliases("hydra")
      .withExposedPorts({ container: 4444, host: 4444 }, { container: 4445, host: 4445 })
      .withEnvironment({
        DSN: "memory",
        URLS_SELF_ISSUER: ORY_ISSUER,
        URLS_LOGIN: "http://localhost:4433/self-service/login/browser",
        URLS_CONSENT: "http://localhost:4455/consent",
        URLS_LOGOUT: "http://localhost:4455/logout",
        URLS_POST_LOGOUT_REDIRECT: ORY_POST_LOGOUT_URI,
        SECRETS_SYSTEM,
      })
      .withWaitStrategy(Wait.forHttp("/health/ready", 4445)),
  );

/**
 * The identity provider, with the login flow Hydra delegates to.
 *
 * The admin API lives under an `/admin` prefix — `/health/ready` on 4434 is a
 * 307 to `/admin/health/ready`, which a wait strategy reads as not-ready.
 */
const sharedKratos = async (): Promise<StartedTestContainer> => {
  const config = new URL("../config/kratos.yml", import.meta.url);
  const schema = new URL("../config/identity.schema.json", import.meta.url);
  const content = await digest(config, schema);

  return shared("ory-kratos", () =>
    new GenericContainer("oryd/kratos:v1.3.1")
      .withCommand(["serve", "--config", "/etc/config/kratos.yml", "--dev"])
      .withNetworkMode(ORY_NETWORK)
      .withNetworkAliases("kratos")
      .withExposedPorts({ container: 4433, host: 4433 }, { container: 4434, host: 4434 })
      .withLabels({ [CONTENT_LABEL]: content })
      .withCopyFilesToContainer([
        { source: fileURLToPath(config), target: "/etc/config/kratos.yml" },
        { source: fileURLToPath(schema), target: "/etc/config/identity.schema.json" },
      ])
      .withWaitStrategy(Wait.forHttp("/admin/health/ready", 4434)),
  );
};

/**
 * The consent and logout endpoint, which this repository owns because Hydra has
 * no mode in which it is unreachable: `skip_consent` and `skip_logout_consent`
 * are advice to a consent application, never permission to omit one.
 */
const sharedConsent = async (): Promise<StartedTestContainer> => {
  const handler = new URL("./ory-consent.mjs", import.meta.url);
  const content = await digest(handler);

  return shared("ory-consent", () =>
    new GenericContainer("node:24-alpine")
      .withCommand(["node", "/app/consent.mjs"])
      .withNetworkMode(ORY_NETWORK)
      .withNetworkAliases("consent")
      .withExposedPorts({ container: 4455, host: 4455 })
      .withLabels({ [CONTENT_LABEL]: content })
      .withCopyFilesToContainer([{ source: fileURLToPath(handler), target: "/app/consent.mjs" }])
      .withEnvironment({
        HYDRA_ADMIN_URL: "http://hydra:4445",
        KRATOS_ADMIN_URL: "http://kratos:4434",
        PORT: "4455",
      })
      .withWaitStrategy(Wait.forHttp("/consent", 4455).forStatusCode(400)),
  );
};

export type Ory = {
  readonly hydra: StartedTestContainer;
  readonly kratos: StartedTestContainer;
  readonly consent: StartedTestContainer;
};

/**
 * The three containers, then {@link provisionOry} — every attach, because both
 * DSNs are `memory` and a restarted container has forgotten everything.
 *
 * Kratos reaches Hydra by network alias, so the network comes first; the
 * consent handler follows the pair it calls.
 */
export const sharedOry = async (): Promise<Ory> => {
  await ensureNetwork();
  const [hydra, kratos] = await Promise.all([sharedHydra(), sharedKratos()]);
  const consent = await sharedConsent();
  await provisionOry();

  return { hydra, kratos, consent };
};
