---
title: Keep envelope keys per owner
description: Give every tenant a root key of its own with @btravstack/keys — provision a generation under its AWS KMS key, derive a key per purpose, rotate by adding a generation, erase the tenant in one call, and size the cache TTL.
---

<!-- doctest: prelude
import { Module, Port, Provider } from "@btravstack/di";
import { Err, Ok, P, type AsyncResult } from "unthrown";
-->

# Keep envelope keys per owner

> **How-to.** A multi-tenant service encrypts each tenant's payloads and
> objects under keys of that tenant's own, so that erasing the tenant is
> deleting one key rather than finding every byte it ever wrote.
> `@btravstack/keys` keeps one root key per owner, in generations, wrapped by
> an AWS KMS key of that owner.

The surface is [the reference page](/reference/keys); this page is the order
to do things in.

## Give each owner a KMS key

Each owner needs a symmetric KMS key under the alias
`<KEYS_KMS_ALIAS_PREFIX><owner>`. Create it where the owner is created, beside
whatever else onboarding provisions:

```sh
key=$(aws kms create-key --query KeyMetadata.KeyId --output text)
aws kms create-alias --alias-name "alias/tenant-$TENANT" --target-key-id "$key"
```

Compose the adapter, and set its two required variables:

```ts
import { EnvelopeKeys } from "@btravstack/keys";
import { kmsKeys } from "@btravstack/keys/kms";

export const Keys = Module("HowToKeys")({
  imports: [kmsKeys()],
  exports: [EnvelopeKeys],
});
```

```sh
KEYS_KMS_REGION=eu-west-3
KEYS_KMS_ALIAS_PREFIX=alias/tenant-
```

## Provision a generation

`provision(owner, keyId)` asks KMS for a fresh data key under the owner's KMS
key and answers only its wrapped form. Keep it with the key id; it is not
secret, so a mounted Secret, a file, an object or a row will do:

```ts
import { type KeyErased, type KeyGeneration, type KeysUnavailable } from "@btravstack/keys";

class Custody extends Port("HowToCustody")<{
  readonly keep: (generation: KeyGeneration) => AsyncResult<void, never>;
}> {}

class Onboarding extends Port("HowToOnboarding")<{
  readonly onboard: (owner: string) => AsyncResult<void, KeyErased | KeysUnavailable>;
}> {}

export const onboarding = Provider(Onboarding)({
  inject: { keys: EnvelopeKeys, custody: Custody },
  sync: ({ keys, custody }) => ({
    onboard: (owner) => keys.provision(owner, "k1").flatMap((generation) => custody.keep(generation)),
  }),
});
```

The key id names the generation everywhere it is used: store it beside every
ciphertext the generation's keys produce, so a reader knows which generation
to unwrap.

## Derive a key per purpose

Never encrypt with the root. Derive a key for each use, so each use has a key,
and a nonce budget, of its own:

```ts
import { deriveKey, type EnvelopeKeysService } from "@btravstack/keys";

declare const service: EnvelopeKeysService;
declare const generation: KeyGeneration;

const payloadKey = service.rootKey(generation).flatMap((root) =>
  deriveKey(root, { namespace: "payloads", purpose: "seal", version: 1 }, {
    algorithm: { name: "AES-GCM", length: 256 },
    usages: ["encrypt", "decrypt"],
  }),
);
```

`objects/seal/v1` and `payloads/seal/v1` are two unrelated keys from one
root. Raising `version` gives a purpose a new key without touching the root.

## Rotate

Rotation adds a generation: provision `k2`, and encrypt everything new with
it. Ciphertexts under `k1` stay readable, since `k1` is still wrapped by the
same KMS key; re-encrypt them under `k2` at your own pace if a policy
requires it, then drop `k1` from custody. KMS's own automatic rotation of the
owner's key is independent, and safe to turn on: KMS keeps every backing key
it ever used for that key, so old blobs still unwrap.

## Erase an owner, in one call

```ts
declare const owner: string;

const erased = service.erase(owner);
```

`erase` schedules the deletion of the owner's KMS key. From that moment KMS
refuses every generation of the owner, and `rootKey` answers `KeyErased` for
each one, so every ciphertext under any of them is unreadable. There is no
data to find and delete; the wrapped blobs may stay where they are, since
nothing can unwrap them any more.

A caller turns `KeyErased` into "this owner is erased" for every reason it
carries (disabled, pending deletion, missing, refused):

```ts
const reading = service
  .rootKey(generation)
  .map((): "readable" | "erased" => "readable")
  .flatMapErrCases((matcher) =>
    matcher
      .with(P.tag("KeyErased"), () => Ok("erased" as const))
      .with(P.tag("KeysUnavailable"), (unavailable) => Err(unavailable)),
  );
```

`KeysUnavailable` stays an error: it is an outage (throttling, the network, a
permission), retried rather than reported as the owner gone.

`KEYS_KMS_PENDING_WINDOW_DAYS` (`7` to `30`, default `30`) is how long an
operator can still cancel the deletion with `aws kms cancel-key-deletion` and
re-enable the key. It does not delay the erasure: the key is unusable while it
is pending.

## Size the TTL

`KEYS_CACHE_TTL_MS` (default five minutes) is the one trade:

- **KMS requests.** Each process unwraps each generation it uses once per TTL.
  With `P` processes and `G` generations in use, that is about
  `P × G × 86 400 000 / TTL` `Decrypt` requests a day; at five minutes, 288 per
  generation per process.
- **Erasure latency.** The process that called `erase` forgets the owner's
  keys at once. Every other process keeps serving the keys it unwrapped until
  they expire, so the TTL is the longest an erased owner's data stays readable
  anywhere.

Raise it when KMS's request quota or bill is the constraint, lower it when an
erasure must take effect faster; `0` asks KMS on every call. A spec pins it
with `kmsKeys({ cacheTtlMs })` and a fake `clock`.
