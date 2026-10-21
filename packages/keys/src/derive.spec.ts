import { webcrypto } from "node:crypto";

import { allAsync, fromSafePromise } from "unthrown";
import { describe, expect } from "vitest";

import { it, signature } from "./__tests__/test-fixtures.js";
import { InvalidKeyPurpose, deriveKey, type KeyPurpose } from "./derive.js";

describe("deriveKey", () => {
  it("should derive the same key for the same purpose", async () => {
    // GIVEN a root key
    const root = rootKey();

    // WHEN one purpose is derived twice
    const signatures = await root.flatMap((key) =>
      allAsync([signed(key, purpose()), signed(key, purpose())]),
    );

    // THEN both are one key
    expect(signatures.map(([a, b]) => a === b)).toBeOkWith(true);
  });

  it("should derive distinct keys for distinct purposes, namespaces and versions", async () => {
    // GIVEN a root key
    const root = rootKey();

    // WHEN purposes differing in one segment each are derived
    const signatures = await root.flatMap((key) =>
      allAsync([
        signed(key, purpose()),
        signed(key, purpose({ purpose: "seal" })),
        signed(key, purpose({ namespace: "objects" })),
        signed(key, purpose({ version: 2 })),
      ]),
    );

    // THEN no two are the same key
    expect(signatures.map((all) => new Set(all).size)).toBeOkWith(4);
  });

  it("should derive an AES-GCM key that is not extractable", async () => {
    // GIVEN a root key
    const root = rootKey();

    // WHEN an AES-GCM key is derived from it
    const derived = await root.flatMap((key) =>
      deriveKey(key, purpose(), {
        algorithm: { name: "AES-GCM", length: 256 },
        usages: ["encrypt", "decrypt"],
      }),
    );

    // THEN it is that key, and nothing can export it
    expect(derived).toBeOkWith(
      expect.objectContaining({
        algorithm: { name: "AES-GCM", length: 256 },
        extractable: false,
        usages: ["encrypt", "decrypt"],
      }),
    );
  });

  it("should refuse a segment that would make the info ambiguous", async () => {
    // GIVEN a purpose carrying the separator
    const ambiguous = purpose({ namespace: "payloads/seal" });

    // WHEN it is derived
    const derived = await rootKey().flatMap((key) => deriveKey(key, ambiguous, SIGNING));

    // THEN it is refused
    expect(derived).toBeErrWith(new InvalidKeyPurpose(ambiguous));
  });

  it("should refuse an empty purpose", async () => {
    // GIVEN a purpose with no name
    const empty = purpose({ purpose: "" });

    // WHEN it is derived
    const derived = await rootKey().flatMap((key) => deriveKey(key, empty, SIGNING));

    // THEN it is refused
    expect(derived).toBeErrWith(new InvalidKeyPurpose(empty));
  });

  it("should refuse a version that is not a positive integer", async () => {
    // GIVEN versions zero and one and a half
    const versions = [purpose({ version: 0 }), purpose({ version: 1.5 })];

    // WHEN each is derived
    const derived = await rootKey().flatMap((key) =>
      allAsync(
        versions.map((version) =>
          deriveKey(key, version, SIGNING)
            .map((): string => "derived")
            .recoverErrCases((matcher) =>
              matcher.with({ _tag: "InvalidKeyPurpose" }, () => "refused"),
            ),
        ),
      ),
    );

    // THEN both are refused
    expect(derived).toBeOkWith(["refused", "refused"]);
  });
});

const purpose = (overrides: Partial<KeyPurpose> = {}): KeyPurpose => ({
  namespace: "payloads",
  purpose: "sign",
  version: 1,
  ...overrides,
});

const rootKey = () =>
  fromSafePromise(
    webcrypto.subtle.importKey("raw", new Uint8Array(32).fill(7), "HKDF", false, ["deriveKey"]),
  );

const signed = (root: webcrypto.CryptoKey, keyPurpose: KeyPurpose) =>
  deriveKey(root, keyPurpose, SIGNING).flatMap(signature);

const SIGNING = { algorithm: { name: "HMAC", hash: "SHA-256" }, usages: ["sign"] } as const;
