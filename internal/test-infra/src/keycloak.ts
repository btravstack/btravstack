import { randomUUID } from "node:crypto";

import { createRemoteJWKSet, jwtVerify } from "jose";
import { GenericContainer, Wait } from "testcontainers";

import { shared } from "./containers.js";

/** The real token exchange issuer, reused per machine; each fixture owns a realm. */
export const sharedKeycloak = () =>
  shared("keycloak", () =>
    new GenericContainer("quay.io/keycloak/keycloak:26.8.0")
      .withExposedPorts(8080)
      .withEnvironment({
        KC_BOOTSTRAP_ADMIN_USERNAME: "admin",
        KC_BOOTSTRAP_ADMIN_PASSWORD: "admin",
      })
      .withCommand(["start-dev", "--features=token-exchange-delegation,parameterized-scopes"])
      .withWaitStrategy(Wait.forHttp("/realms/master/.well-known/openid-configuration", 8080)),
  );

const checked = async (response: Response): Promise<Response> => {
  if (!response.ok) {
    // oxlint-disable-next-line unthrown/no-throw -- test provisioning fails the fixture by rejecting
    throw new Error(`Keycloak fixture: ${response.status} ${await response.text()}`);
  }
  return response;
};

/** A realm's subjects and confidential gateway, granted an orders audience and service actor claim. */
export const createExchangeClient = async () => {
  const server = await sharedKeycloak();
  const origin = `http://${server.getHost()}:${server.getMappedPort(8080)}`;
  const admin = (await checked(
    await fetch(`${origin}/realms/master/protocol/openid-connect/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username: "admin",
        password: "admin",
      }),
    }),
  ).then((response) => response.json())) as { access_token: string };
  const realm = `exchange-${randomUUID()}`;
  const audience = (target: string) => ({
    name: `audience-${target}`,
    protocol: "openid-connect",
    protocolMapper: "oidc-audience-mapper",
    config: { "included.client.audience": target, "access.token.claim": "true" },
  });
  await checked(
    await fetch(`${origin}/admin/realms`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${admin.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        realm,
        enabled: true,
        sslRequired: "none",
        accessTokenLifespan: 300,
        clients: [
          {
            clientId: "frontend",
            secret: "frontend-secret",
            publicClient: false,
            directAccessGrantsEnabled: true,
            protocol: "openid-connect",
            protocolMappers: [audience("gateway")],
          },
          {
            clientId: "gateway",
            secret: "gateway-secret",
            publicClient: false,
            serviceAccountsEnabled: true,
            protocol: "openid-connect",
            attributes: { "standard.token.exchange.enabled": "true" },
            protocolMappers: [audience("orders")],
          },
          {
            clientId: "orders",
            secret: "orders-secret",
            publicClient: false,
            protocol: "openid-connect",
          },
        ],
        users: ["alice", "bob"].map((username) => ({
          username,
          enabled: true,
          email: `${username}@example.test`,
          emailVerified: true,
          firstName: username,
          lastName: "Fixture",
          credentials: [{ type: "password", value: "fixture-password", temporary: false }],
        })),
      }),
    }),
  );
  const adminGet = async (path: string) =>
    checked(
      await fetch(`${origin}/admin/realms/${realm}/${path}`, {
        headers: { authorization: `Bearer ${admin.access_token}` },
      }),
    );
  const gateway = (await adminGet("clients?clientId=gateway").then((response) =>
    response.json(),
  )) as { id: string }[];
  const frontend = (await adminGet("clients?clientId=frontend").then((response) =>
    response.json(),
  )) as { id: string }[];
  const actorUser = (await adminGet(`clients/${gateway[0]!.id}/service-account-user`).then(
    (response) => response.json(),
  )) as { id: string };
  await checked(
    await fetch(
      `${origin}/admin/realms/${realm}/clients/${frontend[0]!.id}/protocol-mappers/models`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${admin.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "permitted-actor",
          protocol: "openid-connect",
          protocolMapper: "oidc-hardcoded-claim-mapper",
          config: {
            "claim.name": "may_act",
            "claim.value": JSON.stringify({ sub: actorUser.id, client_id: "gateway" }),
            "jsonType.label": "JSON",
            "access.token.claim": "true",
          },
        }),
      },
    ),
  );
  const issuer = `${origin}/realms/${realm}`;
  const actorResponse = (await checked(
    await fetch(`${issuer}/protocol/openid-connect/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "gateway",
        client_secret: "gateway-secret",
      }),
    }),
  ).then((response) => response.json())) as { access_token: string };
  const actor = {
    token: actorResponse.access_token,
    tokenType: "urn:ietf:params:oauth:token-type:access_token",
  };
  const subject = async (username: string) => {
    const response = await checked(
      await fetch(`${issuer}/protocol/openid-connect/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "password",
          client_id: "frontend",
          client_secret: "frontend-secret",
          username,
          password: "fixture-password",
        }),
      }),
    );
    const token = (await response.json()) as { access_token: string };
    return {
      actor,
      token: token.access_token,
      tokenType: "urn:ietf:params:oauth:token-type:access_token",
    };
  };
  const keys = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`));
  return {
    env: {
      OAUTH_ISSUER: issuer,
      OAUTH_CLIENT_ID: "gateway",
      OAUTH_CLIENT_SECRET: "gateway-secret",
    },
    actorId: actorUser.id,
    alice: await subject("alice"),
    bob: await subject("bob"),
    introspect: async (token: string) => {
      const response = await checked(
        await fetch(`${issuer}/protocol/openid-connect/token/introspect`, {
          method: "POST",
          body: new URLSearchParams({
            client_id: "orders",
            client_secret: "orders-secret",
            token,
          }),
        }),
      );
      const status = (await response.json()) as { active: boolean };
      const { payload } = await jwtVerify(token, keys, { issuer, audience: "orders" });
      return { ...payload, active: status.active };
    },
  };
};
