import { Module, Port, Provider } from "@btravstack/di";
import { oauthClient } from "@btravstack/oauth-client";

import {
  createHttpClient,
  HttpClient,
  httpClient,
  httpClientFetch,
  type HttpPolicy,
} from "./index.js";

class IntegrationPolicy extends Port("IntegrationPolicy")<HttpPolicy> {}
const Integrations = Module("Integrations")({
  imports: [httpClient(IntegrationPolicy)],
  provides: [
    Provider(IntegrationPolicy)({
      inject: {},
      value: { origins: ["https://api.example"], maxResponseBytes: 1048576, deadlineMs: 5000 },
    }),
  ],
  exports: [HttpClient],
});
void Integrations;
const oauth = createHttpClient({
  origins: ["https://login.example"],
  maxResponseBytes: 65536,
  deadlineMs: 5000,
}).map((client) =>
  oauthClient({ issuer: "https://login.example", fetch: httpClientFetch(client) }),
);
void oauth;

const secretCache: { current: import("./index.js").HttpTlsIdentity } = {
  current: { cert: "PEM chain", key: "PEM private key" },
};
const paymentIdentity: import("./index.js").HttpTlsBinding = {
  origin: "https://payments.example",
  credentials: () => secretCache.current,
};
const payments = createHttpClient({
  origins: [paymentIdentity.origin],
  tlsIdentities: [paymentIdentity],
  maxResponseBytes: 65536,
  deadlineMs: 5000,
});
void payments;

payments.map((client) => {
  // @ts-expect-error Request input cannot override TLS verification.
  client.request({ url: paymentIdentity.origin, rejectUnauthorized: false });
});

const controlPlane: import("./index.js").HttpPrivateOrigin = {
  origin: "https://apisix-admin.platform.svc.cluster.local:9444",
  cidrs: ["10.96.0.0/16", "fd00:1234::/32"],
};
const adminClient = createHttpClient({
  origins: [controlPlane.origin],
  privateOrigins: [controlPlane],
  maxResponseBytes: 65_536,
  deadlineMs: 5_000,
});
void adminClient;
