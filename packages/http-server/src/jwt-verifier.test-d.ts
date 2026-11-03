import type { EnvironmentFor, EnvReading } from "@btravstack/config";
import { Port, type Provider } from "@btravstack/di";
import { expectTypeOf } from "vitest";

import {
  JwtVerifier,
  jwtVerifier,
  type JwtVerifierOptions,
  type JwtVerifierService,
} from "./jwt.js";

const configured = jwtVerifier();
const prefixed = jwtVerifier({ variablePrefix: "EVIDENCE" });
const pinned = jwtVerifier({
  jwks: "https://issuer.example/jwks",
  issuer: "https://issuer.example",
});

expectTypeOf<EnvironmentFor<NeedsOf<typeof configured>>>().toEqualTypeOf<
  EnvironmentFor<EnvReading<"HTTP_JWT_JWKS_URI" | "HTTP_JWT_ISSUER", never>>
>();
expectTypeOf<EnvironmentFor<NeedsOf<typeof prefixed>>>().toEqualTypeOf<
  EnvironmentFor<EnvReading<"EVIDENCE_JWKS_URI" | "EVIDENCE_ISSUER", never>>
>();
expectTypeOf<EnvironmentFor<NeedsOf<typeof pinned>>>().toEqualTypeOf<Record<never, never>>();

class PartnerVerifier extends Port("PartnerVerifier")<JwtVerifierService> {}
const partner = jwtVerifier({ port: PartnerVerifier });
const partnerPort: typeof PartnerVerifier = partner.port;
const defaultPort: typeof JwtVerifier = configured.port;

class WrongVerifier extends Port("WrongVerifier")<{ readonly unrelated: true }> {}
// @ts-expect-error a verifier port must implement the same evidence verification service
jwtVerifier({ port: WrongVerifier });

declare const options: JwtVerifierOptions;
const dynamic = jwtVerifier(options);
// @ts-expect-error an optional custom port cannot promise the default port identity
const assumedDefault: typeof JwtVerifier = dynamic.port;

declare const verifier: JwtVerifierService;
// @ts-expect-error the expected audience is mandatory for every verification
verifier.verify({ token: "evidence" });
// @ts-expect-error a request cannot replace the configured issuer
verifier.verify({ token: "evidence", audience: "service", issuer: "https://other.example" });

type NeedsOf<T> = T extends Provider<infer _P, infer _E, infer N> ? N : never;
