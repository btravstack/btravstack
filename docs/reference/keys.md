---
title: "@btravstack/keys"
description: The complete surface of @btravstack/keys — the EnvelopeKeys port, KeyGeneration, KeyErased and KeysUnavailable, deriveKey and KeyPurpose, kmsKeys() over AWS KMS with its cache, erasure and Observers seam, and the KEYS_* variables.
---

<!-- doctest: prelude
import { Module, Port, Provider } from "@btravstack/di";
import { Err, Ok, P, type AsyncResult } from "unthrown";
-->

# @btravstack/keys

> **Reference.** A complete, structured description of `@btravstack/keys`:
> the `EnvelopeKeys` port a multi-tenant service depends on for one root key
> per owner, its two modeled errors, `deriveKey` for a key per purpose, and
> `kmsKeys()`, the AWS KMS adapter.

An **owner** is whoever a key belongs to, a tenant usually. Each owner has a
KMS key of its own, and any number of **generations**, each a root key wrapped
by that KMS key and named by a **key id**. Erasing the owner is deleting its
KMS key: every generation becomes unreadable at once, and with it whatever was
encrypted under a key derived from one. The recipe is
[Keep envelope keys per owner](/how-to/keep-envelope-keys-per-owner).

```sh
pnpm add @btravstack/keys @btravstack/core @btravstack/config @btravstack/di unthrown
pnpm add @aws-sdk/client-kms # for @btravstack/keys/kms
```

Every dependency is a peer. `@aws-sdk/client-kms` is optional: only
`@btravstack/keys/kms` imports it, so a package that only derives keys, or
depends on the port, never installs it. Node `>=22`.

## The port

<!-- doctest: signature=@btravstack/keys -->

```ts
type KeyGeneration = {
  readonly owner: string;
  readonly keyId: string;
  readonly wrapped: Uint8Array;
};
```

`EnvelopeKeys`'s service has three methods.

| Method                    | Answers                                                          |
| ------------------------- | ---------------------------------------------------------------- |
| `rootKey(generation)`     | `AsyncResult<webcrypto.CryptoKey, KeyErased \| KeysUnavailable>` |
| `provision(owner, keyId)` | `AsyncResult<KeyGeneration, KeyErased \| KeysUnavailable>`       |
| `erase(owner)`            | `AsyncResult<void, KeysUnavailable>`                             |

- **`rootKey`** unwraps a generation in memory and answers a non-extractable
  HKDF `webcrypto.CryptoKey` (usages `deriveKey`, `deriveBits`): a root to derive from,
  never one to encrypt with. It is kept for the cache's TTL, and callers asking
  for one generation while it is being unwrapped share one request.
- **`provision`** makes a new generation under the owner's KMS key and answers
  it. `wrapped` is not secret, so the application keeps it wherever it keeps
  configuration: a mounted Secret, a file, an object store, a row. Rotating is
  provisioning another key id; the earlier generations stay readable.
- **`erase`** erases every generation of the owner at once. Erasing an owner
  already erased, or one that never had a key, answers `Ok`.

The key id is the application's: it records which generation encrypted what,
beside the ciphertext, and chooses which one encrypts next.

## The errors

| Error             | Fields                        | Means                                                                                |
| ----------------- | ----------------------------- | ------------------------------------------------------------------------------------ |
| `KeyErased`       | `owner`, `keyId`, `reason`    | the generation will never be unwrapped again: an answer, not an outage               |
| `KeysUnavailable` | `operation`, `owner`, `cause` | KMS could not be asked: throttling, the network, a permission; asked again next call |

`reason` says why a generation is erased:

| `reason`           | KMS said                                                                              |
| ------------------ | ------------------------------------------------------------------------------------- |
| `disabled`         | `DisabledException`: the owner's key is disabled                                      |
| `pending_deletion` | `KMSInvalidStateException`: the owner's key is scheduled for deletion                 |
| `not_found`        | `NotFoundException`: the owner has no key under its alias                             |
| `refused`          | `InvalidCiphertextException` or `IncorrectKeyException`: not this owner's or key id's |

A blob presented for another key id, or another owner, is `refused` rather than
unwrapped: the encryption context binds both, so it can never answer someone
else's key. A caller says "erased" for all four the same way:

```ts
import { EnvelopeKeys, type KeyGeneration, type KeysUnavailable } from "@btravstack/keys";

class Readable extends Port("ReferenceReadable")<{
  readonly check: (generation: KeyGeneration) => AsyncResult<"readable" | "erased", KeysUnavailable>;
}> {}

export const readable = Provider(Readable)({
  inject: { keys: EnvelopeKeys },
  sync: ({ keys }) => ({
    check: (generation) =>
      keys
        .rootKey(generation)
        .map((): "readable" | "erased" => "readable")
        .flatMapErrCases((matcher) =>
          matcher
            .with(P.tag("KeyErased"), () => Ok("erased" as const))
            .with(P.tag("KeysUnavailable"), (unavailable) => Err(unavailable)),
        ),
  }),
});
```

## deriveKey

```ts
import type { webcrypto } from "node:crypto";

import { deriveKey } from "@btravstack/keys";

declare const root: webcrypto.CryptoKey;

const sealing = deriveKey(root, { namespace: "payloads", purpose: "seal", version: 1 }, {
  algorithm: { name: "AES-GCM", length: 256 },
  usages: ["encrypt", "decrypt"],
});
```

`deriveKey(root, purpose, derived)` answers
`AsyncResult<webcrypto.CryptoKey, InvalidKeyPurpose>`: HKDF-SHA-256 over the root, an
empty salt (the root is uniformly random already) and
`info = <namespace>/<purpose>/v<version>`. The key is never extractable.

<!-- doctest: signature=@btravstack/keys -->

```ts
type KeyPurpose = {
  readonly namespace: string;
  readonly purpose: string;
  readonly version: number;
};
```

- **One key per purpose, so one nonce budget per purpose.** Two uses never
  draw random AES-GCM nonces from one key.
- **`namespace` and `purpose`** are ASCII letters, digits, `.`, `_` and `-`,
  so no two purposes spell the same `info`. A `/`, an empty segment or a
  `version` that is not a positive integer is `InvalidKeyPurpose`.
- **`version`** retires a derived key without a new root: raise it, and
  derive the old one for what it already protects.
- **`derived`** is WebCrypto's: `algorithm` an AES or HMAC key type, `usages`
  what the key may do.

## kmsKeys()

```ts
import { kmsKeys } from "@btravstack/keys/kms";

export const Keys = Module("ReferenceKeys")({
  imports: [kmsKeys()],
  exports: [EnvelopeKeys],
});
```

`kmsKeys(options?)` from `@btravstack/keys/kms` answers a `Module` providing
`EnvelopeKeys` over AWS KMS. Each owner's KMS key is named by the alias
`<KEYS_KMS_ALIAS_PREFIX><owner>`; creating that key and its alias is the
platform's, beside the owner itself.

| KMS request                          | Made by     | With                                                                      |
| ------------------------------------ | ----------- | ------------------------------------------------------------------------- |
| `GenerateDataKeyWithoutPlaintext`    | `provision` | the owner's alias, `KeySpec: AES_256`, context `{ owner, keyId }`         |
| `Decrypt`                            | `rootKey`   | the owner's alias as `KeyId`, context `{ owner, keyId }`                  |
| `DescribeKey`, `ScheduleKeyDeletion` | `erase`     | the alias resolved to its key id, `PendingWindowInDays` from the variable |

The plaintext `Decrypt` answers is imported as the root and zeroed; it never
leaves the adapter. Credentials are the AWS SDK's default chain: a workload
identity, an instance profile or `AWS_*` variables. The IAM policy a
deployment grants is `kms:Decrypt` and `kms:GenerateDataKeyWithoutPlaintext`
on the owners' keys, and `kms:DescribeKey` and `kms:ScheduleKeyDeletion` to
whatever erases. The encryption context can condition every one of them
(`kms:EncryptionContext:owner`).

### Configuration

| Variable                       | Default                  | Pinned by           | Meaning                                                            |
| ------------------------------ | ------------------------ | ------------------- | ------------------------------------------------------------------ |
| `KEYS_KMS_REGION`              | required                 | —                   | the AWS region of the owners' keys                                 |
| `KEYS_KMS_ALIAS_PREFIX`        | required                 | —                   | an owner's alias is this prefix and the owner, `alias/tenant-` say |
| `KEYS_KMS_ENDPOINT`            | AWS's own for the region | `endpoint`          | a KMS-compatible emulator or a VPC endpoint; an absolute URL       |
| `KEYS_CACHE_TTL_MS`            | `300000` (five minutes)  | `cacheTtlMs`        | how long an unwrapped root is kept; `0` keeps nothing              |
| `KEYS_KMS_PENDING_WINDOW_DAYS` | `30` (AWS's own)         | `pendingWindowDays` | the days a scheduled deletion can be cancelled, `7` to `30`        |

`clock` (default: the kernel's `systemClock`) is an option only: what the
TTL is measured against, a fake clock in a spec.

**The TTL is the one trade.** A process asks KMS once per generation per TTL,
and a process that did not erase an owner serves its keys until they expire.
The process that erased forgets them at once. Every generation answers
`KeyErased` from the moment its deletion is scheduled; the pending window only
bounds how long an operator can still cancel it.

### Observation

Every KMS request is reported to `Observers` as `component: "keys"`, with
`name` and the `operation` attribute `unwrap`, `provision` or `erase`, and the
owner and key id as details (`btravstack.keys.owner`, `btravstack.keys.key_id`),
never dimensions. A key served from memory reports nothing.

| Answer            | Settles                                                  |
| ----------------- | -------------------------------------------------------- |
| a key, a blob, ok | `ok`, `result: "ok"`                                     |
| `KeyErased`       | `ok`, `result: "erased"`, `reason` as in the table above |
| `KeysUnavailable` | `error`, `result: "error"`, with the error as `cause`    |

An erased generation is the answer erasure exists to give, so it is counted
rather than written as a fault line; `KeysUnavailable` is what pages somebody.

### What it leaves out

- **No health check.** A probe would be a paid KMS request per probe per pod,
  and an owner's key being unusable is an answer, not a fault.
- **No in-process adapter.** Specs run against a KMS emulator; this package's
  own run against LocalStack.
- **No custody store.** Where `wrapped` lives, and which generation is
  current, are the application's.
