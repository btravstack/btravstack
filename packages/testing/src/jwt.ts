import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";
import { fromSafePromise, type AsyncResult } from "unthrown";

const KID = "k1";

export type LocalIssuerOptions = {
  readonly issuer: string;
  readonly audience: string;
  /** Asymmetric only, the same list `jwtAuthenticator` accepts; default `"RS256"`. */
  readonly algorithm?: "RS256" | "RS384" | "RS512" | "ES256" | "ES384";
};

export type SignOptions = {
  readonly issuer?: string;
  readonly audience?: string;
  /** `"5m"` by default; `false` mints a token with no `exp` at all. */
  readonly expiresIn?: string | false;
};

export type LocalIssuer = {
  /** `http://127.0.0.1:<port>/jwks.json` — served on ANY path, so a caller need not match it exactly. */
  readonly jwks: string;
  /** The public key as served, with `kid`/`alg`/`use` already set. */
  readonly jwk: JWK;
  readonly issuer: string;
  readonly audience: string;
  readonly sign: (claims?: JWTPayload, options?: SignOptions) => AsyncResult<string, never>;
  readonly close: () => AsyncResult<void, never>;
};

/**
 * A real JWKS endpoint and a matching signer, for a test that wants a genuine
 * fetch and a genuine verify rather than a double for either.
 *
 * The whole `LocalIssuer` is minted from one call: a key pair, a `node:http`
 * listener answering the JWKS on any path, and `sign` closing over the
 * private key. `close()` stops the listener; nothing else needs tearing down.
 */
export const localIssuer = (options: LocalIssuerOptions): AsyncResult<LocalIssuer, never> => {
  const algorithm = options.algorithm ?? "RS256";

  return fromSafePromise(
    (async () => {
      const { publicKey, privateKey } = await generateKeyPair(algorithm, { extractable: true });
      const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: algorithm, use: "sig" };
      const server = createServer((_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ keys: [jwk] }));
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const { port } = server.address() as AddressInfo;

      return {
        jwks: `http://127.0.0.1:${port}/jwks.json`,
        jwk,
        issuer: options.issuer,
        audience: options.audience,
        sign: (claims: JWTPayload = {}, signOptions: SignOptions = {}) =>
          fromSafePromise(
            (async () => {
              const token = new SignJWT(claims)
                .setProtectedHeader({ alg: algorithm, kid: KID })
                .setIssuer(signOptions.issuer ?? options.issuer)
                .setAudience(signOptions.audience ?? options.audience)
                .setIssuedAt();
              if (signOptions.expiresIn !== false) {
                token.setExpirationTime(signOptions.expiresIn ?? "5m");
              }
              return token.sign(privateKey);
            })(),
          ),
        close: () => fromSafePromise(new Promise<void>((done) => server.close(() => done()))),
      };
    })(),
  );
};
