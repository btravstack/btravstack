import { ConfigInvalid, Env } from "@btravstack/config";
import { Module, Provider } from "@btravstack/di";
import { OkAsync, P, allAsync, fromSafePromise } from "unthrown";
import { describe, expect } from "vitest";

import { it, signature } from "./__tests__/test-fixtures.js";
import { deriveKey } from "./derive.js";
import { EnvelopeKeys, KeyErased, KeysUnavailable, type KeyGeneration } from "./keys.js";
import { kmsKeys } from "./kms.js";

describe("kmsKeys", () => {
  describe("provision", () => {
    it("should answer a wrapped generation of the owner and key id", async ({
      keys,
      env,
      owner,
    }) => {
      // GIVEN an owner with a KMS key
      const { owner: id } = await owner();

      // WHEN a generation is provisioned
      const provisioned = await keys({ env }, (ctx) => ctx.get(EnvelopeKeys).provision(id, "k1"));

      // THEN it is the blob to keep, for that owner and key id
      expect(provisioned).toBeOkWith({ owner: id, keyId: "k1", wrapped: expect.any(Uint8Array) });
    });

    it("should unwrap to the same root key in another process", async ({ keys, env, owner }) => {
      // GIVEN a generation provisioned, and a key derived from it, in one graph
      const { owner: id } = await owner();
      const signed = (generation: KeyGeneration) =>
        keys({ env }, (ctx) =>
          ctx
            .get(EnvelopeKeys)
            .rootKey(generation)
            .flatMap((root) => deriveKey(root, PURPOSE, SIGNING))
            .flatMap(signature),
        );
      const first = await keys({ env }, (ctx) => ctx.get(EnvelopeKeys).provision(id, "k1"));
      const generation = first.getOrThrow();

      // WHEN two separate graphs unwrap it
      const both = await allAsync([signed(generation), signed(generation)]);

      // THEN both hold the same key
      expect(both.map(([a, b]) => a === b)).toBeOkWith(true);
    });

    it("should answer erased for an owner whose key is disabled", async ({ keys, env, owner }) => {
      // GIVEN an owner whose key is disabled
      const subject = await owner();
      await subject.disable();

      // WHEN a generation is provisioned
      const provisioned = await keys({ env }, (ctx) =>
        ctx.get(EnvelopeKeys).provision(subject.owner, "k1"),
      );

      // THEN no generation can be made under it
      expect(provisioned).toBeErrWith(
        new KeyErased({ owner: subject.owner, keyId: "k1", reason: "disabled" }),
      );
    });
  });

  describe("rootKey", () => {
    it("should answer a non-extractable HKDF key", async ({ keys, env, owner }) => {
      // GIVEN a provisioned generation
      const { owner: id } = await owner();

      // WHEN it is unwrapped
      const root = await keys({ env }, (ctx) =>
        ctx
          .get(EnvelopeKeys)
          .provision(id, "k1")
          .flatMap((generation) => ctx.get(EnvelopeKeys).rootKey(generation)),
      );

      // THEN it is a root to derive from, which nothing can export
      expect(root).toBeOkWith(
        expect.objectContaining({
          algorithm: { name: "HKDF" },
          extractable: false,
          usages: expect.arrayContaining(["deriveKey", "deriveBits"]),
        }),
      );
    });

    it("should keep an unwrapped key for the TTL", async ({
      keys,
      env,
      owner,
      observations,
      clock,
    }) => {
      // GIVEN a generation unwrapped once
      const { owner: id } = await owner();

      // WHEN it is asked again just before the TTL
      const answers = await keys({ env, cacheTtlMs: 1_000 }, (ctx) => {
        const service = ctx.get(EnvelopeKeys);
        return service.provision(id, "k1").flatMap((generation) =>
          service.rootKey(generation).flatMap((first) =>
            clock
              .advance(999)
              .flatMap(() => service.rootKey(generation))
              .map((second) => first === second),
          ),
        );
      });

      // THEN KMS was asked once, and the same key answered twice
      expect(
        answers.map((same) => ({
          same,
          unwraps: observations.filter(({ operation }) => operation.name === "unwrap").length,
        })),
      ).toBeOkWith({ same: true, unwraps: 1 });
    });

    it("should unwrap again once the TTL has passed", async ({
      keys,
      env,
      owner,
      observations,
      clock,
    }) => {
      // GIVEN a generation unwrapped once
      const { owner: id } = await owner();

      // WHEN it is asked again at the TTL
      const answers = await keys({ env, cacheTtlMs: 1_000 }, (ctx) => {
        const service = ctx.get(EnvelopeKeys);
        return service.provision(id, "k1").flatMap((generation) =>
          service
            .rootKey(generation)
            .flatMap(() => clock.advance(1_000))
            .flatMap(() => service.rootKey(generation)),
        );
      });

      // THEN KMS was asked twice
      expect(
        answers.map(
          () => observations.filter(({ operation }) => operation.name === "unwrap").length,
        ),
      ).toBeOkWith(2);
    });

    it("should keep nothing with a TTL of zero", async ({ keys, env, owner, observations }) => {
      // GIVEN a cache that keeps nothing
      const { owner: id } = await owner();

      // WHEN one generation is asked, then another, then the first again
      const answers = await keys({ env, cacheTtlMs: 0 }, (ctx) => {
        const service = ctx.get(EnvelopeKeys);
        return allAsync([service.provision(id, "k1"), service.provision(id, "k2")]).flatMap(
          ([first, second]) =>
            service
              .rootKey(first)
              .flatMap(() => service.rootKey(second))
              .flatMap(() => service.rootKey(first)),
        );
      });

      // THEN KMS was asked each time
      expect(
        answers.map(
          () => observations.filter(({ operation }) => operation.name === "unwrap").length,
        ),
      ).toBeOkWith(3);
    });

    it("should share one request between concurrent callers", async ({
      keys,
      env,
      owner,
      observations,
    }) => {
      // GIVEN a provisioned generation nobody has unwrapped
      const { owner: id } = await owner();

      // WHEN two callers ask for it at once
      const answers = await keys({ env }, (ctx) => {
        const service = ctx.get(EnvelopeKeys);
        return service
          .provision(id, "k1")
          .flatMap((generation) =>
            allAsync([service.rootKey(generation), service.rootKey(generation)]),
          );
      });

      // THEN KMS was asked once, and both have the same key
      expect(
        answers.map(([a, b]) => ({
          same: a === b,
          unwraps: observations.filter(({ operation }) => operation.name === "unwrap").length,
        })),
      ).toBeOkWith({ same: true, unwraps: 1 });
    });

    it("should answer erased when the owner's key is disabled", async ({ keys, env, owner }) => {
      // GIVEN a generation whose owner's key is then disabled
      const subject = await owner();
      const generation = (
        await keys({ env }, (ctx) => ctx.get(EnvelopeKeys).provision(subject.owner, "k1"))
      ).getOrThrow();
      await subject.disable();

      // WHEN it is unwrapped
      const root = await keys({ env }, (ctx) => ctx.get(EnvelopeKeys).rootKey(generation));

      // THEN it is erased
      expect(root).toBeErrWith(
        new KeyErased({ owner: subject.owner, keyId: "k1", reason: "disabled" }),
      );
    });

    it("should answer erased when the owner's key is pending deletion", async ({
      keys,
      env,
      owner,
    }) => {
      // GIVEN a generation whose owner's key is then scheduled for deletion
      const subject = await owner();
      const generation = (
        await keys({ env }, (ctx) => ctx.get(EnvelopeKeys).provision(subject.owner, "k1"))
      ).getOrThrow();
      await subject.scheduleDeletion();

      // WHEN it is unwrapped
      const root = await keys({ env }, (ctx) => ctx.get(EnvelopeKeys).rootKey(generation));

      // THEN it is erased
      expect(root).toBeErrWith(
        new KeyErased({ owner: subject.owner, keyId: "k1", reason: "pending_deletion" }),
      );
    });

    it("should answer erased when the owner has no key", async ({ keys, env, owner }) => {
      // GIVEN a generation presented for an owner nobody created a key for
      const { owner: id } = await owner();
      const generation = (
        await keys({ env }, (ctx) => ctx.get(EnvelopeKeys).provision(id, "k1"))
      ).getOrThrow();

      // WHEN it is unwrapped as that unknown owner's
      const root = await keys({ env }, (ctx) =>
        ctx.get(EnvelopeKeys).rootKey({ ...generation, owner: "nobody" }),
      );

      // THEN it is erased
      expect(root).toBeErrWith(
        new KeyErased({ owner: "nobody", keyId: "k1", reason: "not_found" }),
      );
    });

    it("should refuse a generation presented under another key id", async ({
      keys,
      env,
      owner,
    }) => {
      // GIVEN the generation of key id k1
      const { owner: id } = await owner();
      const generation = (
        await keys({ env }, (ctx) => ctx.get(EnvelopeKeys).provision(id, "k1"))
      ).getOrThrow();

      // WHEN it is presented as key id k2
      const root = await keys({ env }, (ctx) =>
        ctx.get(EnvelopeKeys).rootKey({ ...generation, keyId: "k2" }),
      );

      // THEN the encryption context refuses it, rather than a key being answered
      expect(root).toBeErrWith(new KeyErased({ owner: id, keyId: "k2", reason: "refused" }));
    });

    it("should refuse a generation presented under another owner", async ({ keys, env, owner }) => {
      // GIVEN the generation of one owner, and a second owner with a key of its own
      const first = await owner();
      const second = await owner();
      const generation = (
        await keys({ env }, (ctx) => ctx.get(EnvelopeKeys).provision(first.owner, "k1"))
      ).getOrThrow();

      // WHEN it is presented as the second owner's
      const root = await keys({ env }, (ctx) =>
        ctx.get(EnvelopeKeys).rootKey({ ...generation, owner: second.owner }),
      );

      // THEN the second owner's key refuses it
      expect(root).toBeErrWith(
        new KeyErased({ owner: second.owner, keyId: "k1", reason: "refused" }),
      );
    });

    it("should answer unavailable when KMS cannot be reached", async ({ keys, env }) => {
      // GIVEN an endpoint nothing listens on
      const unreachable = { ...env, KEYS_KMS_ENDPOINT: "http://127.0.0.1:1" };

      // WHEN a generation is unwrapped
      const root = await keys({ env: unreachable }, (ctx) =>
        ctx
          .get(EnvelopeKeys)
          .rootKey({ owner: "o", keyId: "k1", wrapped: new Uint8Array([1, 2, 3]) }),
      );

      // THEN it is an outage, not an erasure
      expect(root).toBeErrWith(
        expect.objectContaining({ constructor: KeysUnavailable, operation: "unwrap", owner: "o" }),
      );
    });
  });

  describe("erase", () => {
    it("should erase every generation of the owner, cached ones included", async ({
      keys,
      env,
      owner,
    }) => {
      // GIVEN two generations of an owner, both unwrapped and kept
      const { owner: id } = await owner();

      // WHEN the owner is erased and both are asked again
      const answers = await keys({ env }, (ctx) => {
        const service = ctx.get(EnvelopeKeys);
        return allAsync([service.provision(id, "k1"), service.provision(id, "k2")]).flatMap(
          (generations) =>
            allAsync(generations.map((generation) => service.rootKey(generation)))
              .flatMap(() => service.erase(id))
              .flatMap(() =>
                allAsync(
                  generations.map((generation) =>
                    service
                      .rootKey(generation)
                      .map((): string => "kept")
                      .recoverErrCases((matcher) =>
                        matcher
                          .with(P.tag("KeyErased"), ({ reason }) => reason)
                          .with(P.tag("KeysUnavailable"), () => "unavailable"),
                      ),
                  ),
                ),
              ),
        );
      });

      // THEN each is erased
      expect(answers).toBeOkWith(["pending_deletion", "pending_deletion"]);
    });

    it("should schedule the deletion of the owner's key with the pending window", async ({
      keys,
      env,
      owner,
    }) => {
      // GIVEN an owner with a key
      const subject = await owner();

      // WHEN it is erased with a pending window of a week
      const erased = await keys({ env, pendingWindowDays: 7 }, (ctx) =>
        ctx.get(EnvelopeKeys).erase(subject.owner),
      );

      // THEN its key is pending deletion, for a week
      expect(
        await erased
          .toAsync()
          .flatMap(() => fromSafePromise(subject.metadata()))
          .map((key) => ({
            state: key?.KeyState,
            days: Math.round((Number(key?.DeletionDate) - Number(key?.CreationDate)) / 86_400_000),
          })),
      ).toBeOkWith({ state: "PendingDeletion", days: 7 });
    });

    it("should answer ok for an owner already erased", async ({ keys, env, owner }) => {
      // GIVEN an owner erased once
      const { owner: id } = await owner();

      // WHEN it is erased again
      const erased = await keys({ env }, (ctx) =>
        ctx
          .get(EnvelopeKeys)
          .erase(id)
          .flatMap(() => ctx.get(EnvelopeKeys).erase(id)),
      );

      // THEN erasure is idempotent
      expect(erased).toBeOk();
    });

    it("should answer ok for an owner with no key", async ({ keys, env }) => {
      // GIVEN an owner nobody created a key for
      const id = "nobody";

      // WHEN it is erased
      const erased = await keys({ env }, (ctx) => ctx.get(EnvelopeKeys).erase(id));

      // THEN there is nothing left to erase
      expect(erased).toBeOk();
    });

    it("should answer unavailable when KMS cannot be reached", async ({ keys, env }) => {
      // GIVEN an endpoint nothing listens on
      const unreachable = { ...env, KEYS_KMS_ENDPOINT: "http://127.0.0.1:1" };

      // WHEN an owner is erased
      const erased = await keys({ env: unreachable }, (ctx) => ctx.get(EnvelopeKeys).erase("o"));

      // THEN it is an outage
      expect(erased).toBeErrWith(
        expect.objectContaining({ constructor: KeysUnavailable, operation: "erase", owner: "o" }),
      );
    });
  });

  describe("observation", () => {
    it("should settle an erased generation as an ordinary answer", async ({
      keys,
      env,
      owner,
      observations,
    }) => {
      // GIVEN a generation of an owner whose key is disabled
      const subject = await owner();
      const generation = (
        await keys({ env }, (ctx) => ctx.get(EnvelopeKeys).provision(subject.owner, "k1"))
      ).getOrThrow();
      await subject.disable();

      // WHEN it is unwrapped
      await keys({ env }, (ctx) => ctx.get(EnvelopeKeys).rootKey(generation));

      // THEN the unwrap is counted as erased, with no fault
      expect(observations.at(-1)).toEqual({
        operation: {
          component: "keys",
          name: "unwrap",
          attributes: { operation: "unwrap" },
          details: { "btravstack.keys.owner": subject.owner, "btravstack.keys.key_id": "k1" },
        },
        settled: { outcome: "ok", attributes: { result: "erased", reason: "disabled" } },
      });
    });

    it("should settle an outage as an error", async ({ keys, env, observations }) => {
      // GIVEN an endpoint nothing listens on
      const unreachable = { ...env, KEYS_KMS_ENDPOINT: "http://127.0.0.1:1" };

      // WHEN an owner is erased
      await keys({ env: unreachable }, (ctx) => ctx.get(EnvelopeKeys).erase("o"));

      // THEN the erase is a fault, carrying its cause
      expect(observations).toEqual([
        {
          operation: {
            component: "keys",
            name: "erase",
            attributes: { operation: "erase" },
            details: { "btravstack.keys.owner": "o" },
          },
          settled: {
            outcome: "error",
            attributes: { result: "error" },
            cause: expect.any(KeysUnavailable),
          },
        },
      ]);
    });
  });

  describe("configuration", () => {
    it("should build on AWS's own endpoint and the system clock by default", async ({ env }) => {
      // GIVEN an environment that names no endpoint
      const { KEYS_KMS_ENDPOINT: _, ...aws } = env;

      // WHEN the graph is built from the defaults alone
      const built = await Module.scoped(
        Module("Defaults")({
          imports: [kmsKeys()],
          provides: [Provider(Env)({ inject: {}, value: aws })],
          exports: [EnvelopeKeys],
        }),
        (ctx) => OkAsync(Object.keys(ctx.get(EnvelopeKeys)).sort()),
      );

      // THEN it provides the port, without a request
      expect(built).toBeOkWith(["erase", "provision", "rootKey"]);
    });

    it("should refuse a pending window KMS does not accept", async ({ keys, env }) => {
      // GIVEN a pending window under KMS's minimum of a week
      const short = { ...env, KEYS_KMS_PENDING_WINDOW_DAYS: "5" };

      // WHEN the graph is built
      const built = await keys({ env: short }, (ctx) => ctx.get(EnvelopeKeys).erase("o"));

      // THEN the variable is named
      expect(built).toBeErrWith(
        expect.objectContaining({
          constructor: ConfigInvalid,
          message: expect.stringContaining("KEYS_KMS_PENDING_WINDOW_DAYS"),
        }),
      );
    });

    it("should refuse an endpoint that is not a URL", async ({ keys, env }) => {
      // GIVEN an endpoint that is not one
      const malformed = { ...env, KEYS_KMS_ENDPOINT: "localhost" };

      // WHEN the graph is built
      const built = await keys({ env: malformed }, (ctx) => ctx.get(EnvelopeKeys).erase("o"));

      // THEN the variable is named
      expect(built).toBeErrWith(
        expect.objectContaining({
          constructor: ConfigInvalid,
          message: expect.stringContaining("KEYS_KMS_ENDPOINT"),
        }),
      );
    });

    it("should refuse a pinned endpoint that is not a URL", async ({ keys, env }) => {
      // GIVEN an endpoint pinned by the composition root, not a URL
      const endpoint = "localhost";

      // WHEN the graph is built
      const built = await keys({ env, endpoint }, (ctx) => ctx.get(EnvelopeKeys).erase("o"));

      // THEN the variable it pins is named
      expect(built).toBeErrWith(
        expect.objectContaining({
          constructor: ConfigInvalid,
          message: expect.stringContaining("KEYS_KMS_ENDPOINT"),
        }),
      );
    });
  });
});

const SIGNING = { algorithm: { name: "HMAC", hash: "SHA-256" }, usages: ["sign"] } as const;
const PURPOSE = { namespace: "tests", purpose: "sign", version: 1 };
