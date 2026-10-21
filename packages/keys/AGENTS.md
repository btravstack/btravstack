# AGENTS.md — @btravstack/keys

Envelope keys for a multi-tenant service: an `EnvelopeKeys` port an
application depends on for one root key per owner, in generations, wrapped by
a KMS key of that owner; `kmsKeys()` providing it over AWS KMS; and
`deriveKey`, giving each purpose a key of its own. The root `AGENTS.md` is the
authoritative spec.

## Public surface

The exports are `src/index.ts` and `src/kms.ts` (`@btravstack/keys/kms`), each
with its TSDoc; `docs/reference/keys.md` is the reader's page and
`docs/how-to/keep-envelope-keys-per-owner.md` the recipe.

## Decisions

- **A package of its own, not a `storage` subpath.** Keys protect Temporal
  payloads as much as stored objects, so a consumer sealing payloads would
  have depended on the object-storage port to get them, and `storage`'s
  surface would have grown a second concern. `config` and `core` know no
  vendor. The root entry (the port, the errors, `deriveKey`) needs no AWS SDK;
  the adapter is behind `/kms`, with `@aws-sdk/client-kms` an optional peer.
- **One port, not the cache/storage pair.** As in `oauth-client`, what is
  observed is a KMS request, which only the real adapter makes: a key served
  from memory reports nothing, so there is no wrapper for a second port to
  separate.
- **The caller hands the generation in.** `rootKey` takes the wrapped blob
  with its owner and key id rather than reading a custody store: the blob is
  not secret and its home varies (a mounted Secret, a file, an object, a row),
  so a store port would have been a second adapter to write for no
  protection. `provision` answers the blob for the application to keep.
- **The encryption context binds `{ owner, keyId }`, and `Decrypt` names the
  owner's alias as its `KeyId`.** A blob presented under another key id fails
  the context (`InvalidCiphertextException`), under another owner the key
  (`IncorrectKeyException`): both are `KeyErased` with `reason: "refused"`,
  never another key. LocalStack proves both.
- **Erased is an answer.** `DisabledException`, `KMSInvalidStateException`,
  `NotFoundException`, `InvalidCiphertextException` and
  `IncorrectKeyException` are `KeyErased`; everything else KMS or the network
  says is `KeysUnavailable`, never cached. `KMSInvalidStateException` is read
  as pending deletion: for a key in a custom key store it can also mean a
  disconnected store, which this adapter cannot tell apart. It settles `ok`
  with `result: "erased"`, the root's "an ordinary answer is not a fault line".
- **Erasure is `DescribeKey` then `ScheduleKeyDeletion`.** The second takes a
  key id or ARN, never an alias (LocalStack accepts one; AWS does not). A
  missing alias, or a key already pending deletion, answers `Ok`, so erasing
  twice is idempotent. The pending window is configuration, not an argument:
  the port takes no default behind it, and the window is a deployment's
  policy.
- **The cache is per generation, for a TTL, single-flight.** A generation is
  its owner, its key id and its blob: provisioning one key id twice (a retried
  onboarding) makes two roots, and keying on the id alone would answer the
  first for the second. Callers asking
  while a generation is being unwrapped share that `AsyncResult`; only an
  `Ok` is kept. Expired entries are swept whenever a new one is kept, so the
  map holds the generations used within one TTL. `erase` forgets the owner's
  entries in this process; an unwrap KMS answered before the deletion may
  still be kept until it expires, exactly as in every other process, which is
  why the TTL is documented as the erasure latency.
- **The root is an HKDF key, never an encryption key.** It is imported
  non-extractable with `deriveKey`/`deriveBits` only, and the plaintext KMS
  answered is zeroed once imported. `deriveKey` uses an empty salt (the root
  is uniformly random, RFC 5869 §3.1) and refuses a segment with a `/`, so
  `info` is unambiguous.
- **Region and alias prefix are required variables with no option.** Neither
  has a default that could be right, and neither is a value a test fixes
  differently from a deployment. `KEYS_KMS_ENDPOINT`, `KEYS_CACHE_TTL_MS` and
  `KEYS_KMS_PENDING_WINDOW_DAYS` are pinned by options, each default stated:
  AWS's endpoint, five minutes, AWS's own thirty days. Credentials are the
  SDK's default chain, the way a workload identity reaches a pod.

## Deliberately not here

- **No health check.** It would be a paid KMS request per probe per pod, and
  an unusable owner key is an answer, not a fault.
- **No in-process adapter.** Nothing here needs one: the specs run against
  LocalStack's KMS, one KMS key under a UUID alias per test.
- **No owner provisioning.** Creating an owner's KMS key and alias is the
  platform's, beside the owner itself; the how-to shows the two calls.
- **No "current generation".** Which key id encrypts next is the
  application's, recorded beside its ciphertexts.

Observation: see the root `AGENTS.md`, **Observability is a set port, never a flag**.
