import { Observers, noObserverMember, observed } from "@btravstack/core";
import { Module, Provider, type PortClassOf } from "@btravstack/di";

import { createHttpClient, snapshotRequest } from "./client.js";
import { HttpClient, type HttpPolicy } from "./contracts.js";

/** Provide an observed outbound capability from an application-owned policy port. */
export const httpClient = <const Id extends string>(policy: PortClassOf<Id, HttpPolicy>) =>
  Module("HttpClient")({
    provides: [
      noObserverMember,
      Provider(HttpClient)({
        inject: { policy, observers: Observers },
        make: ({ policy, observers }) =>
          createHttpClient(policy)
            .toAsync()
            .map((client) => ({
              request: (input) => {
                const request = snapshotRequest(input);
                return observed(
                  observers,
                  {
                    component: "http-client",
                    name: "request",
                    attributes: { operation: "request" },
                  },
                  () => client.request(request),
                );
              },
            })),
      }),
    ],
    exports: [HttpClient],
  });
