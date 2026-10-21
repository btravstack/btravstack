import { randomUUID, webcrypto } from "node:crypto";

import {
  CreateAliasCommand,
  CreateKeyCommand,
  DescribeKeyCommand,
  DisableKeyCommand,
  KMSClient,
  ScheduleKeyDeletionCommand,
  type KeyMetadata,
} from "@aws-sdk/client-kms";
import { Env, type ConfigInvalid, type Environment } from "@btravstack/config";
import { Observers, type Operation, type Settle, type Settled } from "@btravstack/core";
import { Module, Provider, type Context } from "@btravstack/di";
import { createFakeClock, type FakeClock } from "@btravstack/testing";
import { fromSafePromise, type AsyncResult } from "unthrown";
import { inject, test } from "vitest";

import { EnvelopeKeys } from "../keys.js";
import { kmsKeys, type KmsKeysOptions } from "../kms.js";

/** The alias prefix every test's owners share; the owner part is a UUID, so tests never meet. */
export const ALIAS_PREFIX = "alias/btravstack-test-";

/** One operation an observer was handed, with how it settled. */
export type Observation = {
  readonly operation: Operation;
  settled?: Settled;
};

/** A graph around `kmsKeys(options)`, over the fixtures' clock and observer, run for the length of `body`. */
export type Keys = <T, E>(
  options: KmsKeysOptions & { readonly env: Environment },
  body: (ctx: Context<EnvelopeKeys>) => AsyncResult<T, E>,
) => AsyncResult<T, E | ConfigInvalid>;

/** An owner with a KMS key of its own under `<ALIAS_PREFIX><owner>`, and what the emulator can do to that key. */
export type Owner = {
  readonly owner: string;
  readonly disable: () => Promise<void>;
  readonly scheduleDeletion: () => Promise<void>;
  readonly metadata: () => Promise<KeyMetadata | undefined>;
};

export type KeysFixtures = {
  readonly clock: FakeClock;
  /** The environment a deployment against the emulator sets. */
  readonly env: Environment;
  /** Every KMS request the adapter reported, in order. */
  readonly observations: Observation[];
  readonly keys: Keys;
  /** Mints an owner with a KMS key of its own. */
  readonly owner: () => Promise<Owner>;
};

export const it = test.extend<KeysFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- vitest's fixture signature: one that names no other fixture still takes the destructured first parameter
  clock: async ({}, use) => {
    await use(createFakeClock());
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  env: async ({}, use) => {
    await use({
      KEYS_KMS_REGION: "us-east-1",
      KEYS_KMS_ALIAS_PREFIX: ALIAS_PREFIX,
      KEYS_KMS_ENDPOINT: inject("__TESTCONTAINERS_KMS_ENDPOINT__"),
    });
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  observations: async ({}, use) => {
    await use([]);
  },
  keys: async ({ clock, observations }, use) => {
    const recorder = (operation: Operation): Settle => {
      const observation: Observation = { operation };
      observations.push(observation);
      return (settled) => {
        observation.settled = settled;
      };
    };
    await use(({ env, ...options }, body) =>
      Module.scoped(
        Module("Keys")({
          imports: [kmsKeys({ clock, ...options })],
          provides: [
            Provider(Env)({ inject: {}, value: env }),
            Provider.member(Observers)({ inject: {}, value: recorder }),
          ],
          exports: [EnvelopeKeys],
        }),
        body,
      ),
    );
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  owner: async ({}, use) => {
    const kms = new KMSClient({
      region: "us-east-1",
      endpoint: inject("__TESTCONTAINERS_KMS_ENDPOINT__"),
    });
    await use(async () => {
      const owner = randomUUID();
      const { KeyMetadata: key } = await kms.send(new CreateKeyCommand({}));
      const KeyId = key?.KeyId;
      await kms.send(
        new CreateAliasCommand({ AliasName: `${ALIAS_PREFIX}${owner}`, TargetKeyId: KeyId }),
      );
      return {
        owner,
        disable: async () => {
          await kms.send(new DisableKeyCommand({ KeyId }));
        },
        scheduleDeletion: async () => {
          await kms.send(new ScheduleKeyDeletionCommand({ KeyId, PendingWindowInDays: 7 }));
        },
        metadata: async () => (await kms.send(new DescribeKeyCommand({ KeyId }))).KeyMetadata,
      };
    });
    kms.destroy();
  },
});

/** One fixed message signed with an HMAC key, in hex: two keys are the same key exactly when their signatures agree. */
export const signature = (key: webcrypto.CryptoKey): AsyncResult<string, never> =>
  fromSafePromise(webcrypto.subtle.sign("HMAC", key, new TextEncoder().encode("a message"))).map(
    (signed) => Buffer.from(signed).toString("hex"),
  );
