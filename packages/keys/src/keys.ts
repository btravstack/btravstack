import { Port } from "@btravstack/di";
import { TaggedError, type AsyncResult } from "unthrown";

/**
 * One generation of an owner's root key, as it is kept: wrapped by the
 * owner's key-management key, under an encryption context that binds `owner`
 * and `keyId`.
 *
 * `wrapped` is not secret — only the key-management service can unwrap it, and
 * only for this owner and this key id — so it may live wherever the
 * application keeps configuration: a mounted Secret, a file, an object store,
 * a database row.
 */
export type KeyGeneration = {
  readonly owner: string;
  readonly keyId: string;
  readonly wrapped: Uint8Array;
};

/**
 * The generation can no longer be unwrapped, and never will be again: the
 * owner's key is disabled (`disabled`), scheduled for deletion
 * (`pending_deletion`), gone (`not_found`), or refused this ciphertext under
 * this owner and key id (`refused`). An answer, not an outage: whatever the
 * generation protected is erased.
 */
export class KeyErased extends TaggedError("KeyErased")<{
  readonly owner: string;
  readonly keyId: string;
  readonly reason: "disabled" | "pending_deletion" | "not_found" | "refused";
}> {
  override message = "the key generation is erased";
}

/**
 * The key-management service could not be asked: throttling, the network, a
 * credential or permission it refused, a server error. Transient or a
 * deployment mistake, never an erasure, so a later call asks again: a failure
 * is never cached.
 */
export class KeysUnavailable extends TaggedError("KeysUnavailable")<{
  readonly operation: "unwrap" | "provision" | "erase";
  readonly owner: string;
  readonly cause: unknown;
}> {
  override message = "the key-management service could not be asked";
}

export type EnvelopeKeysService = {
  /**
   * The generation's root key, unwrapped in memory: a non-extractable HKDF
   * key, to derive a key per purpose from with `deriveKey`. Kept for the
   * cache's TTL; callers asking while it is being unwrapped share one request.
   */
  readonly rootKey: (
    generation: KeyGeneration,
  ) => AsyncResult<CryptoKey, KeyErased | KeysUnavailable>;

  /**
   * A new generation under the owner's key, for the application to keep.
   * Rotation is provisioning another key id; the old generations stay
   * readable until the owner is erased.
   */
  readonly provision: (
    owner: string,
    keyId: string,
  ) => AsyncResult<KeyGeneration, KeyErased | KeysUnavailable>;

  /**
   * Every generation of the owner, erased at once: the owner's key is
   * scheduled for deletion, so from then on each generation answers
   * `KeyErased`. Erasing an owner already erased answers `Ok`.
   */
  readonly erase: (owner: string) => AsyncResult<void, KeysUnavailable>;
};

/**
 * The port an application depends on for per-owner envelope keys.
 * `kmsKeys()` from `@btravstack/keys/kms` provides it over AWS KMS.
 */
export class EnvelopeKeys extends Port("EnvelopeKeys")<EnvelopeKeysService> {}
