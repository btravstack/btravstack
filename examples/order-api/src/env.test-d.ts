import { start, type StartEnvironment } from "@btravstack/core";

import { OrderApi } from "./module.js";

declare const deployment: StartEnvironment<typeof OrderApi>;

// `userAuth` pins no issuer, so a deployment that forgot HTTP_JWT_ISSUER is
// refused at the call — `api.spec.ts` asserts the run-time refusal of the same.
const { HTTP_JWT_ISSUER: _issuer, ...withoutIssuer } = deployment;
// @ts-expect-error HTTP_JWT_ISSUER is required: nothing pins it
start(OrderApi, { env: withoutIssuer });

// A variable the root does not read is refused too.
// @ts-expect-error DATABSE_URL is no variable any reader names
start(OrderApi, { env: { ...deployment, DATABSE_URL: "postgres://orders" } });
