import {
  DecryptCommand,
  DescribeKeyCommand,
  GenerateDataKeyWithoutPlaintextCommand,
  KMSClient,
  ScheduleKeyDeletionCommand,
  type KeyMetadata,
} from "@aws-sdk/client-kms";
import {
  Config,
  Env,
  type ConfigField,
  type ConfigInvalid,
  type EnvReading,
} from "@btravstack/config";
import {
  Observers,
  noObserverMember,
  observed,
  systemClock,
  type Clock,
  type Operation,
  type Settle,
  type Settled,
} from "@btravstack/core";
import { Module, Port, Provider, type Scope, type ServiceOf } from "@btravstack/di";
import {
  Err,
  Ok,
  OkAsync,
  P,
  fromPromise,
  fromSafePromise,
  type AsyncResult,
  type FailureView,
} from "unthrown";

import {
  EnvelopeKeys,
  KeyErased,
  KeysUnavailable,
  type EnvelopeKeysService,
  type KeyGeneration,
} from "./keys.js";

/** What the graph bound from the environment for the KMS adapter. */
class KeysConfig extends Port("KeysConfig")<{
  readonly region: string;
  readonly aliasPrefix: string;
  readonly endpoint: string | undefined;
  readonly cacheTtlMs: number;
  readonly pendingWindowDays: number;
}> {}

/** The client, as a port of its own, so the scope closing destroys it. */
class KmsConnection extends Port("KmsConnection")<KMSClient> {}

const optionalUrl = <const V extends string>(
  variable: V,
): ConfigField<string | undefined, V, "optional"> => {
  const url = Config.url(variable);
  return {
    variable,
    parse: (raw) => (raw === undefined ? Ok(undefined) : url.parse(raw)),
    // Only a pin is checked, and a pin is never `undefined`.
    check: (value) => url.parse(String(value)),
  };
};

/** What {@link kmsKeys} is handed. Each value option pins the variable named beside it. */
export type KmsKeysOptions = {
  /**
   * Pins `KEYS_KMS_ENDPOINT` (default: AWS's own endpoint for the region): a
   * KMS-compatible emulator, or a VPC endpoint.
   */
  readonly endpoint?: string;
  /**
   * Pins `KEYS_CACHE_TTL_MS` (default `300000`, five minutes): how long an
   * unwrapped root key is kept. It bounds two things at once: the KMS
   * requests, one per generation per process per TTL, and how long a process
   * that did not erase an owner keeps serving that owner's keys after it was
   * erased. `0` keeps nothing.
   */
  readonly cacheTtlMs?: number;
  /**
   * Pins `KEYS_KMS_PENDING_WINDOW_DAYS` (default `30`, AWS's own, between 7
   * and 30): the days a scheduled deletion can still be cancelled. Every
   * generation answers `KeyErased` from the moment it is scheduled.
   */
  readonly pendingWindowDays?: number;
  /** What the cache's TTL is measured against (default: the kernel's `systemClock`). */
  readonly clock?: Clock;
};

/** The variables {@link kmsKeys} reads: two required, the rest defaulted or pinnable. */
export type KmsKeysEnv = EnvReading<
  "KEYS_KMS_REGION" | "KEYS_KMS_ALIAS_PREFIX",
  "KEYS_KMS_ENDPOINT" | "KEYS_CACHE_TTL_MS" | "KEYS_KMS_PENDING_WINDOW_DAYS"
>;

/**
 * `EnvelopeKeys` over AWS KMS, with one KMS key per owner, named by the alias
 * `<KEYS_KMS_ALIAS_PREFIX><owner>`.
 *
 * ```ts
 * Module("Documents")({ imports: [kmsKeys()], provides: [sealer] });
 * ```
 *
 * - **Configured from `KEYS_KMS_REGION` and `KEYS_KMS_ALIAS_PREFIX`** (an
 *   alias prefix, `alias/tenant-` say), and the pinnable variables of
 *   {@link KmsKeysOptions}. Credentials are the AWS SDK's default chain: a
 *   workload identity, an instance profile, or `AWS_*` variables.
 * - **A generation is a KMS data key**: `provision` asks
 *   `GenerateDataKeyWithoutPlaintext` for an AES-256 key under the owner's
 *   KMS key, and `rootKey` unwraps it with `Decrypt`, both with the encryption
 *   context `{ owner, keyId }` and the owner's alias as the key, so a blob
 *   handed in for another owner or key id is refused rather than unwrapped.
 * - **Erasure is one key deletion**: `erase` resolves the owner's alias and
 *   schedules its key's deletion, after which KMS refuses every generation of
 *   the owner. This process forgets the keys it kept at once; another
 *   process keeps serving its own until they expire, which is what
 *   `KEYS_CACHE_TTL_MS` bounds.
 * - **Refusals are answers**: a disabled, deleted, missing or refusing key is
 *   `KeyErased`; anything else KMS says is `KeysUnavailable`, never cached.
 * - **Every KMS request is reported to `Observers`** (`component: "keys"`); a
 *   key served from memory reports nothing.
 */
export const kmsKeys = (
  options: KmsKeysOptions = {},
): Module<EnvelopeKeys, ConfigInvalid, KmsKeysEnv | Scope> =>
  Module("KmsKeys")({
    needs: [Env],
    provides: [
      noObserverMember,
      Config.provider(KeysConfig)(
        Config.object({
          region: Config.string("KEYS_KMS_REGION"),
          aliasPrefix: Config.string("KEYS_KMS_ALIAS_PREFIX"),
          endpoint: Config.pinned(options.endpoint, optionalUrl("KEYS_KMS_ENDPOINT")),
          cacheTtlMs: Config.pinned(
            options.cacheTtlMs,
            Config.integer("KEYS_CACHE_TTL_MS", { default: 300_000, min: 0 }),
          ),
          pendingWindowDays: Config.pinned(
            options.pendingWindowDays,
            Config.integer("KEYS_KMS_PENDING_WINDOW_DAYS", { default: 30, min: 7, max: 30 }),
          ),
        }),
      ),
      Provider(KmsConnection)({
        inject: { config: KeysConfig },
        acquire: ({ config }) =>
          Ok(
            new KMSClient({
              region: config.region,
              ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
            }),
          ),
        release: (client) => client.destroy(),
      }),
      Provider(EnvelopeKeys)({
        inject: { config: KeysConfig, client: KmsConnection, observers: Observers },
        sync: ({ config, client, observers }) =>
          kmsEnvelopeKeys(client, config, observers, options.clock ?? systemClock),
      }),
    ],
    exports: [EnvelopeKeys],
  });

type Observer = (operation: Operation) => Settle;
type Unwrapping = AsyncResult<CryptoKey, KeyErased | KeysUnavailable>;

/** The KMS errors that mean the generation will never be unwrapped again, and the reason each one gives. */
const ERASED = new Map<unknown, KeyErased["reason"]>([
  ["DisabledException", "disabled"],
  ["KMSInvalidStateException", "pending_deletion"],
  ["NotFoundException", "not_found"],
  ["InvalidCiphertextException", "refused"],
  ["IncorrectKeyException", "refused"],
]);

const GONE = new Set<unknown>(["NotFoundException", "KMSInvalidStateException"]);

const nameOf = (cause: unknown): unknown => (Object(cause) as { readonly name?: unknown }).name;

const kmsEnvelopeKeys = (
  client: KMSClient,
  config: ServiceOf<KeysConfig>,
  observers: readonly Observer[],
  clock: Clock,
): EnvelopeKeysService => {
  const cached = new Map<
    string,
    { readonly owner: string; readonly root: CryptoKey; readonly expiresAt: number }
  >();
  const inFlight = new Map<string, Unwrapping>();

  const aliasOf = (owner: string): string => `${config.aliasPrefix}${owner}`;

  const through = <T, E extends KeyErased | KeysUnavailable>(
    name: KeysUnavailable["operation"],
    owner: string,
    keyId: string | undefined,
    call: () => AsyncResult<T, E>,
  ): AsyncResult<T, E> =>
    observed(
      observers,
      {
        component: "keys",
        name,
        attributes: { operation: name },
        details: {
          "btravstack.keys.owner": owner,
          ...(keyId === undefined ? {} : { "btravstack.keys.key_id": keyId }),
        },
      },
      call,
      { ok: () => ({ outcome: "ok", attributes: { result: "ok" } }), failure: settled },
    );

  const request = <T>(
    operation: KeysUnavailable["operation"],
    generation: { readonly owner: string; readonly keyId: string },
    send: () => Promise<T>,
  ): AsyncResult<T, KeyErased | KeysUnavailable> =>
    fromPromise(send(), (cause) => {
      const reason = ERASED.get(nameOf(cause));
      return reason === undefined
        ? new KeysUnavailable({ operation, owner: generation.owner, cause })
        : new KeyErased({ owner: generation.owner, keyId: generation.keyId, reason });
    });

  const unwrap = (entry: string, generation: KeyGeneration): Unwrapping => {
    const { owner, keyId } = generation;
    const unwrapping = through("unwrap", owner, keyId, () =>
      request("unwrap", generation, () =>
        client.send(
          new DecryptCommand({
            CiphertextBlob: generation.wrapped,
            KeyId: aliasOf(owner),
            EncryptionContext: { owner, keyId },
          }),
        ),
      ).flatMap(({ Plaintext }) => {
        // Always set by `Decrypt`; were it missing, `importKey` would reject, a defect.
        const plaintext = Plaintext as Uint8Array<ArrayBuffer>;
        return fromSafePromise(
          crypto.subtle
            .importKey("raw", plaintext, "HKDF", false, ["deriveKey", "deriveBits"])
            .finally(() => plaintext.fill(0)),
        );
      }),
    )
      .tap((root) => {
        inFlight.delete(entry);
        const now = clock.now();
        for (const [key, kept] of cached) if (kept.expiresAt <= now) cached.delete(key);
        cached.set(entry, { owner, root, expiresAt: now + config.cacheTtlMs });
      })
      .tapFailure(() => inFlight.delete(entry));
    inFlight.set(entry, unwrapping);
    return unwrapping;
  };

  return {
    rootKey: (generation) => {
      // The blob too: provisioning one key id twice makes two generations, never one.
      const entry = JSON.stringify([
        generation.owner,
        generation.keyId,
        Buffer.from(generation.wrapped).toString("base64"),
      ]);
      const hit = cached.get(entry);
      if (hit !== undefined && clock.now() < hit.expiresAt) return OkAsync(hit.root);
      cached.delete(entry);
      return inFlight.get(entry) ?? unwrap(entry, generation);
    },

    provision: (owner, keyId) =>
      through("provision", owner, keyId, () =>
        request("provision", { owner, keyId }, () =>
          client.send(
            new GenerateDataKeyWithoutPlaintextCommand({
              KeyId: aliasOf(owner),
              KeySpec: "AES_256",
              EncryptionContext: { owner, keyId },
            }),
          ),
        ).map(({ CiphertextBlob }) => ({ owner, keyId, wrapped: CiphertextBlob as Uint8Array })),
      ),

    erase: (owner) => {
      // A missing alias, or a key already pending deletion: nothing is left to erase.
      const erasing = (cause: unknown) =>
        GONE.has(nameOf(cause))
          ? ("gone" as const)
          : new KeysUnavailable({ operation: "erase", owner, cause });
      return through("erase", owner, undefined, () =>
        // `ScheduleKeyDeletion` takes a key id, never an alias.
        fromPromise(client.send(new DescribeKeyCommand({ KeyId: aliasOf(owner) })), erasing)
          .flatMap(({ KeyMetadata }) =>
            fromPromise(
              client.send(
                new ScheduleKeyDeletionCommand({
                  KeyId: (KeyMetadata as KeyMetadata).KeyId,
                  PendingWindowInDays: config.pendingWindowDays,
                }),
              ),
              erasing,
            ),
          )
          .map((): void => undefined)
          .flatMapErrCases((matcher) =>
            matcher
              .with("gone", () => Ok<void>(undefined))
              .with(P.tag("KeysUnavailable"), (unavailable) => Err(unavailable)),
          ),
      ).tap(() => {
        for (const [key, kept] of cached) if (kept.owner === owner) cached.delete(key);
      });
    },
  };
};

/**
 * **An erased generation settles `ok` with `result: "erased"`, not `error`.**
 * Asking for a key that was erased is the answer erasure exists to give, so
 * it is counted rather than written as a fault line; `KeysUnavailable` is
 * what pages somebody.
 */
const settled = <T>(failure: FailureView<KeyErased | KeysUnavailable, T>): Settled =>
  failure.tag === "Err" && failure.error._tag === "KeyErased"
    ? { outcome: "ok", attributes: { result: "erased", reason: failure.error.reason } }
    : {
        outcome: "error",
        attributes: { result: "error" },
        cause: failure.tag === "Err" ? failure.error : failure.cause,
      };
