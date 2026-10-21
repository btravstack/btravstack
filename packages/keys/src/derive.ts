import type { webcrypto } from "node:crypto";

import { ErrAsync, TaggedError, fromSafePromise, type AsyncResult } from "unthrown";

/**
 * What a derived key is for, spelled into HKDF's `info` as
 * `<namespace>/<purpose>/v<version>`. Each segment is ASCII letters, digits,
 * `.`, `_` or `-`, so no two purposes spell the same `info`; `version` is a
 * positive integer, raised to retire a derived key without a new root.
 */
export type KeyPurpose = {
  readonly namespace: string;
  readonly purpose: string;
  readonly version: number;
};

/** What the derived key is, as WebCrypto's `deriveKey` takes it. It is never extractable. */
export type DerivedKey = {
  readonly algorithm: webcrypto.AesDerivedKeyParams | webcrypto.HmacImportParams;
  readonly usages: readonly webcrypto.KeyUsage[];
};

/** A purpose whose `info` would be ambiguous: a segment outside the alphabet, or a version that is not a positive integer. */
export class InvalidKeyPurpose extends TaggedError("InvalidKeyPurpose")<{
  readonly namespace: string;
  readonly purpose: string;
  readonly version: number;
}> {
  override message = "the key purpose is not a valid HKDF info";
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * A key for one purpose, derived from a root key with HKDF-SHA-256, an empty
 * salt and `info = <namespace>/<purpose>/v<version>`.
 *
 * ```ts
 * keys.rootKey(generation).flatMap((root) =>
 *   deriveKey(root, { namespace: "payloads", purpose: "seal", version: 1 }, {
 *     algorithm: { name: "AES-GCM", length: 256 },
 *     usages: ["encrypt", "decrypt"],
 *   }),
 * );
 * ```
 *
 * Every purpose gets its own key, and so its own nonce budget: two uses of
 * random 96-bit AES-GCM nonces never draw from one key. The salt is empty
 * because the root is already uniformly random (RFC 5869, section 3.1).
 */
export const deriveKey = (
  root: CryptoKey,
  purpose: KeyPurpose,
  derived: DerivedKey,
): AsyncResult<CryptoKey, InvalidKeyPurpose> =>
  SEGMENT.test(purpose.namespace) &&
  SEGMENT.test(purpose.purpose) &&
  Number.isSafeInteger(purpose.version) &&
  purpose.version > 0
    ? fromSafePromise(
        crypto.subtle.deriveKey(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: new Uint8Array(0),
            info: new TextEncoder().encode(
              `${purpose.namespace}/${purpose.purpose}/v${purpose.version}`,
            ),
          },
          root,
          derived.algorithm,
          false,
          [...derived.usages],
        ),
      )
    : ErrAsync(
        new InvalidKeyPurpose({
          namespace: purpose.namespace,
          purpose: purpose.purpose,
          version: purpose.version,
        }),
      );
