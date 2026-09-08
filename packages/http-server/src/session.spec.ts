import type { ConfigInvalid } from "@btravstack/config";
import type { Result } from "unthrown";
import { describe, expect } from "vitest";

import { it, sessionKeys } from "./__tests__/test-fixtures.js";

describe("sessionCodec", () => {
  it("seals a principal and unseals it back", async ({ sessionCodecOf }) => {
    // GIVEN a codec over one key
    const codec = (await sessionCodecOf({ keys: [sessionKeys.alpha] })).getOrThrow();

    // WHEN a principal is sealed and the cookie handed straight back
    const opened = codec
      .seal({ principal: { userId: "u-1" }, sid: "s-1" })
      .flatMap((cookie) => codec.unseal(cookie));

    // THEN the session is what went in, with the lifetime stamped by the codec
    // rather than by the caller
    await expect(opened).toBeOkWith(
      expect.objectContaining({
        principal: { userId: "u-1" },
        sid: "s-1",
        iat: expect.any(Number),
        exp: expect.any(Number),
      }),
    );
  });

  it("answers undefined for a cookie sealed with a key that is gone", async ({
    sessionCodecOf,
  }) => {
    // GIVEN two codecs whose key lists have nothing in common — the deploy that
    // dropped the old key
    const sealer = (await sessionCodecOf({ keys: [sessionKeys.alpha] })).getOrThrow();
    const reader = (await sessionCodecOf({ keys: [sessionKeys.beta] })).getOrThrow();

    // WHEN the second is handed a cookie the first sealed
    const opened = sealer.seal({ principal: { userId: "u-1" } }).flatMap(reader.unseal);

    // THEN the caller is anonymous rather than an error: a cookie nobody can
    // open is not a failed request
    await expect(opened).toBeOkWith(undefined);
  });

  it("unseals a cookie sealed by an older key still in the list", async ({ sessionCodecOf }) => {
    // GIVEN the middle of a rotation: a new key prepended, the old one kept
    const sealer = (await sessionCodecOf({ keys: [sessionKeys.alpha] })).getOrThrow();
    const reader = (
      await sessionCodecOf({ keys: [sessionKeys.beta, sessionKeys.alpha] })
    ).getOrThrow();

    // WHEN a cookie sealed before the rotation arrives
    const opened = sealer.seal({ principal: { userId: "u-1" } }).flatMap(reader.unseal);

    // THEN it still opens — which is what makes rotation prepend, deploy, drop
    await expect(opened).toBeOkWith(expect.objectContaining({ principal: { userId: "u-1" } }));
  });

  it("answers undefined for a cookie past its lifetime", async ({ sessionCodecOf }) => {
    // GIVEN a codec whose sessions end the instant they are minted
    const codec = (await sessionCodecOf({ keys: [sessionKeys.alpha], ttlSec: 0 })).getOrThrow();

    // WHEN one is sealed and read back
    const opened = codec.seal({ principal: { userId: "u-1" } }).flatMap(codec.unseal);

    // THEN it is anonymous: the lifetime is fixed, and an expired cookie is
    // simply not a session
    await expect(opened).toBeOkWith(undefined);
  });

  it("answers undefined for anything that is not a cookie it sealed", async ({
    sessionCodecOf,
  }) => {
    // GIVEN a codec
    const codec = (await sessionCodecOf({ keys: [sessionKeys.alpha] })).getOrThrow();

    // WHEN it is handed no cookie at all, a string that is not a JWE, and a JWE
    // whose ciphertext was edited
    const sealed = (await codec.seal({ principal: { userId: "u-1" } })).get();
    const read = {
      absent: (await codec.unseal(undefined)).get(),
      nonsense: (await codec.unseal("nonsense")).get(),
      tampered: (await codec.unseal(`${sealed.slice(0, -4)}AAAA`)).get(),
    };

    // THEN all three are the same anonymous answer, so nothing outside learns
    // which of them it got wrong
    expect(read).toEqual({ absent: undefined, nonsense: undefined, tampered: undefined });
  });

  it("names HTTP_SESSION_KEYS when a key is not 32 bytes", async ({ sessionCodecOf }) => {
    // GIVEN two bad key lists: one where nothing decodes, one where a good key
    // sits beside a typo
    const messageOf = (built: Result<unknown, ConfigInvalid>): string =>
      built.isErr() ? built.error.message : "WRONGLY ACCEPTED";

    // WHEN each is bound
    const built = {
      allBad: messageOf(await sessionCodecOf({ keys: ["short"] })),
      oneBad: messageOf(await sessionCodecOf({ keys: [sessionKeys.alpha, "short"] })),
    };

    // THEN both are a configuration error naming the variable, at boot — never
    // a failure at the first request
    const named =
      "HttpSession could not be configured:\n  HTTP_SESSION_KEYS: must list base64url keys of 32 bytes";
    expect(built).toEqual({ allBad: named, oneBad: named });
  });
});
