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
