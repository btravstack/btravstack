import { withLock } from "./lock.js";

/**
 * The admin APIs, on the fixed host ports {@link sharedOry} publishes. Both are
 * reached from the host rather than by network alias: only Kratos → Hydra ever
 * crosses container to container.
 */
const KRATOS_ADMIN = "http://localhost:4434/admin";
const HYDRA_ADMIN = "http://localhost:4445/admin";

/** The confidential client the backend-for-frontend authenticates as. */
export const ORY_CLIENT_ID = "orders-bff";

/**
 * Its secret. A gate-only credential on the same footing as `POSTGRES_PASSWORD`
 * — nothing outside this repository authenticates with it.
 */
export const ORY_CLIENT_SECRET = "orders-bff-secret";

/** Registered on the client, and what the authorization code comes back to. */
export const ORY_REDIRECT_URI = "http://localhost:3000/callback";

/** Registered on the client, and where `end_session_endpoint` lands. */
export const ORY_POST_LOGOUT_URI = "http://localhost:3000/";

/** What the client requests: `openid` for the id token, `offline` for a refresh token, and the application's own. */
export const ORY_SCOPE = "openid offline orders:export";

/** One provisioned Kratos identity, with the password its login flow submits. */
export type OryUser = {
  readonly email: string;
  readonly password: string;
  /** A UUIDv7, because the example application's `principal` parses it with `z.uuidv7()`. */
  readonly tenant: string;
};

/** Two identities in two tenants, so a spec can prove one is not the other. */
export const ORY_USERS = {
  alice: {
    email: "alice@btravstack.test",
    password: "correct-horse-battery-staple",
    tenant: "0199a1e0-0000-7000-8000-00000000a11c",
  },
  bob: {
    email: "bob@btravstack.test",
    password: "correct-horse-battery-staple",
    tenant: "0199a1e0-0000-7000-8000-00000000b0b0",
  },
} as const satisfies Record<string, OryUser>;

type Outcome = "existing" | "created";

export type OryProvisioned = {
  readonly identities: Record<keyof typeof ORY_USERS, Outcome>;
  readonly client: Outcome;
};

const send = async (
  url: string,
  init?: { readonly method: string; readonly body: unknown },
): Promise<{ readonly status: number; readonly body: unknown }> => {
  const response = await fetch(
    url,
    init && {
      method: init.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(init.body),
    },
  );
  return { status: response.status, body: await response.json().catch(() => undefined) };
};

const create = async (what: string, url: string, body: unknown): Promise<Outcome> => {
  const created = await send(url, { method: "POST", body });
  return created.status === 201
    ? "created"
    : Promise.reject(
        new Error(
          `Could not create the ${what}: ${created.status} ${JSON.stringify(created.body)}`,
        ),
      );
};

const identity = async (user: OryUser): Promise<Outcome> => {
  const found = await send(
    `${KRATOS_ADMIN}/identities?credentials_identifier=${encodeURIComponent(user.email)}`,
  );
  if (Array.isArray(found.body) && found.body.length > 0) return "existing";

  return create(`identity '${user.email}'`, `${KRATOS_ADMIN}/identities`, {
    schema_id: "user",
    traits: { email: user.email, tenant: user.tenant },
    credentials: { password: { config: { password: user.password } } },
  });
};

const client = async (): Promise<Outcome> => {
  const found = await send(`${HYDRA_ADMIN}/clients/${ORY_CLIENT_ID}`);
  if (found.status === 200) return "existing";

  return create(`client '${ORY_CLIENT_ID}'`, `${HYDRA_ADMIN}/clients`, {
    client_id: ORY_CLIENT_ID,
    client_secret: ORY_CLIENT_SECRET,
    client_name: "Orders BFF",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: ORY_SCOPE,
    redirect_uris: [ORY_REDIRECT_URI],
    post_logout_redirect_uris: [ORY_POST_LOGOUT_URI],
    token_endpoint_auth_method: "client_secret_basic",
  });
};

/**
 * The two identities and the one client, idempotent by lookup-then-create:
 * neither admin API has an upsert.
 *
 * Run on every attach rather than once, because both DSNs are `memory` — a
 * container that is restarted rather than attached to has forgotten every
 * identity, client and signing key.
 */
export const provisionOry = (): Promise<OryProvisioned> =>
  withLock("ory-provision", async () => {
    const [alice, bob] = await Promise.all([identity(ORY_USERS.alice), identity(ORY_USERS.bob)]);
    return { identities: { alice, bob }, client: await client() };
  });
