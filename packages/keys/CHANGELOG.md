# @btravstack/keys

## 0.45.1

### Patch Changes

- @btravstack/config@0.45.1
  - @btravstack/core@0.45.1
  - @btravstack/di@0.45.1

## 0.45.0

### Minor Changes

- 8efc5f6: New package: `@btravstack/keys`, envelope keys for a multi-tenant service. The `EnvelopeKeys` port holds one root key per owner, in generations named by a key id: `provision(owner, keyId)` makes a generation under the owner's AWS KMS key and answers its wrapped blob to keep, `rootKey(generation)` unwraps it in memory into a non-extractable HKDF key, cached for a TTL with one request shared by concurrent callers, and `erase(owner)` schedules the deletion of the owner's KMS key, after which every generation answers `KeyErased`. A disabled, deleted, missing or refusing key is `KeyErased` (`owner`, `keyId`, `reason`); anything else is `KeysUnavailable`, never cached. The encryption context binds `{ owner, keyId }`, so a blob presented for another owner or key id is refused rather than unwrapped. `deriveKey(root, { namespace, purpose, version }, { algorithm, usages })` derives a key per purpose with HKDF-SHA-256.

  `kmsKeys()` from `@btravstack/keys/kms` is the adapter, with `@aws-sdk/client-kms` an optional peer. It reads `KEYS_KMS_REGION` and `KEYS_KMS_ALIAS_PREFIX` (an owner's key is the alias `<prefix><owner>`), and `KEYS_KMS_ENDPOINT` (default AWS's own), `KEYS_CACHE_TTL_MS` (default 300000) and `KEYS_KMS_PENDING_WINDOW_DAYS` (default 30), pinned by `endpoint`, `cacheTtlMs` and `pendingWindowDays`. Every KMS request is reported to `Observers`.

### Patch Changes

- @btravstack/config@0.45.0
  - @btravstack/core@0.45.0
  - @btravstack/di@0.45.0
