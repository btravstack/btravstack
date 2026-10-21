# @btravstack/keys

> An `EnvelopeKeys` port for [`@btravstack/core`](../core): a root key per
> owner, in generations, wrapped by an AWS KMS key of that owner — unwrapped in
> memory and cached for a TTL, erased with one key deletion — and an HKDF
> helper giving each purpose its own key.

📖 **[Documentation](https://btravstack.github.io/btravstack/reference/keys)** ·
[API Reference](https://btravstack.github.io/btravstack/api/keys/)

```sh
pnpm add @btravstack/keys @btravstack/core @btravstack/config @btravstack/di unthrown
pnpm add @aws-sdk/client-kms # for @btravstack/keys/kms
```

Every dependency is a peer, and `@aws-sdk/client-kms` an optional one: only
`@btravstack/keys/kms` imports it.

## A worked example

<!-- doctest: prelude
import { Module, Port, Provider } from "@btravstack/di";
import type { AsyncResult } from "unthrown";
-->

A port that seals a tenant's payloads under a key of that tenant's own, and
the composition that provides the keys:

```ts
import type { webcrypto } from "node:crypto";

import {
  EnvelopeKeys,
  deriveKey,
  type InvalidKeyPurpose,
  type KeyErased,
  type KeyGeneration,
  type KeysUnavailable,
} from "@btravstack/keys";
import { kmsKeys } from "@btravstack/keys/kms";

class PayloadKeys extends Port("ReadmePayloadKeys")<{
  readonly key: (
    generation: KeyGeneration,
  ) => AsyncResult<webcrypto.CryptoKey, KeyErased | KeysUnavailable | InvalidKeyPurpose>;
}> {}

export const payloadKeys = Provider(PayloadKeys)({
  inject: { keys: EnvelopeKeys },
  sync: ({ keys }) => ({
    key: (generation) =>
      keys.rootKey(generation).flatMap((root) =>
        deriveKey(root, { namespace: "payloads", purpose: "seal", version: 1 }, {
          algorithm: { name: "AES-GCM", length: 256 },
          usages: ["encrypt", "decrypt"],
        }),
      ),
  }),
});

export const Sealing = Module("ReadmeSealing")({
  imports: [kmsKeys()],
  provides: [payloadKeys],
  exports: [PayloadKeys],
});
```

Provisioning a generation, rotating, erasing a tenant in one call and sizing
the cache are
[Keep envelope keys per owner](https://btravstack.github.io/btravstack/how-to/keep-envelope-keys-per-owner).

## Options

| Option                         | Where                                      | What it is                                                |
| ------------------------------ | ------------------------------------------ | --------------------------------------------------------- |
| `KEYS_KMS_REGION`              | environment                                | the region of the owners' KMS keys — required             |
| `KEYS_KMS_ALIAS_PREFIX`        | environment                                | an owner's KMS key is `<prefix><owner>` — required        |
| `KEYS_KMS_ENDPOINT`            | environment, pinned by `endpoint`          | an emulator or a VPC endpoint (default: AWS's own)        |
| `KEYS_CACHE_TTL_MS`            | environment, pinned by `cacheTtlMs`        | how long an unwrapped root is kept (default five minutes) |
| `KEYS_KMS_PENDING_WINDOW_DAYS` | environment, pinned by `pendingWindowDays` | the days an erasure can be cancelled (default `30`)       |
| `clock`                        | `kmsKeys({ … })`                           | what the cache's TTL is measured against                  |

The full table — defaults, semantics and the reasoning — lives on
[the reference page](https://btravstack.github.io/btravstack/reference/keys),
which is this list's one detailed home.

## What it decides, and what it does not

**It decides** that a generation is a KMS data key bound by the encryption
context `{ owner, keyId }`, so a blob presented for another owner or key id is
refused rather than unwrapped; that a disabled, deleted, missing or refusing
key is a typed `KeyErased` and anything else KMS says a typed
`KeysUnavailable`; that erasing an owner is one scheduled key deletion; that
every KMS request is reported to `Observers`; and that a derived key is
HKDF-SHA-256 with `info = <namespace>/<purpose>/v<version>`.

**It does not decide** where the wrapped generations are kept, which one
encrypts next, or how the owners' KMS keys are created: those are the
application's and the platform's. The reasoning is in
[`AGENTS.md`](./AGENTS.md).

## License

MIT
