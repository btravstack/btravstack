import type { JWTPayload } from "jose";
import type { AsyncResult } from "unthrown";
import { expectTypeOf } from "vitest";

import { localIssuer, type LocalIssuer } from "./jwt.js";

expectTypeOf(localIssuer({ issuer: "https://issuer.test", audience: "orders-api" })).toEqualTypeOf<
  AsyncResult<LocalIssuer, never>
>();

declare const issuer: LocalIssuer;

const claims: JWTPayload = { sub: "u" };
void issuer.sign(claims);

// @ts-expect-error — claims must be a JWTPayload object, not a primitive
void issuer.sign("nope");

// Positive: an asymmetric algorithm is accepted.
void localIssuer({ issuer: "https://issuer.test", audience: "orders-api", algorithm: "ES256" });

// @ts-expect-error — HS256 is not in the asymmetric algorithm list
void localIssuer({ issuer: "https://issuer.test", audience: "orders-api", algorithm: "HS256" });
