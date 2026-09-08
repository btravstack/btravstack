import { withLock } from "./lock.js";

/**
 * The admin APIs, on the fixed host ports {@link sharedOry} publishes. Both are
 * reached from the host rather than by network alias: only Kratos → Hydra ever
 * crosses container to container.
 */
const KRATOS_ADMIN = "http://localhost:4434/admin";
const HYDRA_ADMIN = "http://localhost:4445/admin";

/** What Hydra is started as, and therefore what a discovery document must answer. */
export const ORY_ISSUER = "http://localhost:4444/";

/** The confidential client the backend-for-frontend authenticates as. */
export const ORY_CLIENT_ID = "orders-bff";

/**
 * Its secret. A gate-only credential on the same footing as `POSTGRES_PASSWORD`
 * — nothing outside this repository authenticates with it.
 */
export const ORY_CLIENT_SECRET = "orders-bff-secret";

/** Registered on the client, and what the authorization code comes back to. */
export const ORY_REDIRECT_URI = "http://localhost:3000/auth/callback";

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

/** A provisioned Kratos identity: its id, which is the `sub` its tokens carry. */
export type OryIdentity = {
  readonly id: string;
  readonly status: Outcome;
};

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

const create = async (what: string, url: string, body: unknown): Promise<unknown> => {
  const created = await send(url, { method: "POST", body });
  if (created.status !== 201)
    // oxlint-disable-next-line unthrown/no-throw -- a vitest fixture reports failure by rejecting; there is no Result channel here
    throw new Error(
      `Could not create the ${what}: ${created.status} ${JSON.stringify(created.body)}`,
    );

  return created.body;
};

/**
 * One identity, idempotent by lookup-then-create, and the per-test boundary on
 * Ory: a spec that needs state nobody else touches mints a user rather than a
 * client of its own.
 */
export const createIdentity = async (user: OryUser): Promise<OryIdentity> => {
  const found = await send(
    `${KRATOS_ADMIN}/identities?credentials_identifier=${encodeURIComponent(user.email)}`,
  );
  const existing = Array.isArray(found.body)
    ? (found.body[0] as { readonly id: string } | undefined)
    : undefined;
  if (existing !== undefined) return { id: existing.id, status: "existing" };

  const made = (await create(`identity '${user.email}'`, `${KRATOS_ADMIN}/identities`, {
    schema_id: "user",
    traits: { email: user.email, tenant: user.tenant },
    credentials: { password: { config: { password: user.password } } },
  })) as { readonly id: string };

  return { id: made.id, status: "created" };
};

const client = async (): Promise<Outcome> => {
  const found = await send(`${HYDRA_ADMIN}/clients/${ORY_CLIENT_ID}`);
  if (found.status === 200) return "existing";

  await create(`client '${ORY_CLIENT_ID}'`, `${HYDRA_ADMIN}/clients`, {
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

  return "created";
};

/**
 * Add a redirect URI to the one client, idempotent by union.
 *
 * `ORY_REDIRECT_URI` is fixed at `:3000` because a redirect protocol needs its
 * URLs registered before anything runs. A spec whose own server binds an
 * ephemeral port has no such URL and the ruling forbids a client of its own, so
 * it registers the URI it ended up listening on instead.
 *
 * A JSON Patch rather than a `PUT` of the whole client, and that is measured:
 * `GET /admin/clients/{id}` does not answer the client secret, so putting back
 * what it did answer would blank the very credential every grant here
 * authenticates with.
 */
export const registerRedirectUri = (uri: string): Promise<void> =>
  withLock("ory-redirect-uris", async () => {
    const found = await send(`${HYDRA_ADMIN}/clients/${ORY_CLIENT_ID}`);
    const registered = (found.body as { readonly redirect_uris?: readonly string[] })
      .redirect_uris ?? [ORY_REDIRECT_URI];
    if (registered.includes(uri)) return;

    const patched = await send(`${HYDRA_ADMIN}/clients/${ORY_CLIENT_ID}`, {
      method: "PATCH",
      body: [{ op: "replace", path: "/redirect_uris", value: [...registered, uri] }],
    });
    if (patched.status !== 200)
      // oxlint-disable-next-line unthrown/no-throw -- a vitest fixture reports failure by rejecting; there is no Result channel here
      throw new Error(
        `Could not register the redirect uri '${uri}': ${patched.status} ${JSON.stringify(patched.body)}`,
      );
  });

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
    const [alice, bob] = await Promise.all([
      createIdentity(ORY_USERS.alice),
      createIdentity(ORY_USERS.bob),
    ]);
    const status = await client();
    await registerRedirectUri(ORY_REDIRECT_URI);
    return { identities: { alice: alice.status, bob: bob.status }, client: status };
  });
