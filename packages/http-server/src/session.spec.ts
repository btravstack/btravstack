import type { ConfigInvalid } from "@btravstack/config";
import { decodeProtectedHeader } from "jose";
import type { Result } from "unthrown";
import { describe, expect } from "vitest";

import { it, sessionKeys } from "./__tests__/test-fixtures.js";

describe("sessionCodec", () => {
  it("seals a principal and unseals it back, on the default lifetime", async ({
    sessionCodecOf,
  }) => {
    // GIVEN a codec over one key, pinning no lifetime
    const codec = (await sessionCodecOf({ keys: [sessionKeys.alpha] })).getOrThrow();

    // WHEN a principal is sealed and the cookie handed straight back
    const opened = codec
      .seal({ principal: { userId: "u-1" }, sid: "s-1" })
      .flatMap((cookie) => codec.unseal(cookie))
      .map((session) => ({ ...session, lifetime: (session?.exp ?? 0) - (session?.iat ?? 0) }));

    // THEN the session is what went in, and the twelve hours are the codec's
    // rather than the caller's
    await expect(opened).toBeOkWith(
      expect.objectContaining({
        principal: { userId: "u-1" },
        sid: "s-1",
        lifetime: 43_200,
      }),
    );
  });

  it("seals under dir and A256GCM, which is what it will open", async ({ sessionCodecOf }) => {
    // GIVEN a codec
    const codec = (await sessionCodecOf({ keys: [sessionKeys.alpha] })).getOrThrow();

    // WHEN a session is sealed and its protected header read back
    const header = (await codec.seal({ principal: { userId: "u-1" } })).map(decodeProtectedHeader);

    // THEN it is direct encryption under AES-256-GCM: the key IS the content
    // key, and nothing weaker is expressible
    await expect(header).toBeOkWith({ alg: "dir", enc: "A256GCM" });
  });

  it("refuses a cookie its own key opens under another algorithm", async ({
    sessionCodecOf,
    forgeSession,
  }) => {
    // GIVEN a forged session under two algorithm pairs `jose` would otherwise
    // accept with this very key — the shape a sibling holder of the key mints
    const codec = (await sessionCodecOf({ keys: [sessionKeys.alpha] })).getOrThrow();
    const payload = { principal: { userId: "attacker" }, iat: 0, exp: 4_102_444_800 };
    const read = {
      weakEnc: (
        await forgeSession(
          sessionKeys.alpha,
          { alg: "dir", enc: "A128CBC-HS256" },
          payload,
        ).flatMap(codec.unseal)
      ).get(),
      wrappedKey: (
        await forgeSession(sessionKeys.alpha, { alg: "A256KW", enc: "A256GCM" }, payload).flatMap(
          codec.unseal,
        )
      ).get(),
    };

    // THEN neither opens: holding the key is not enough, because the codec
    // decrypts only what it issues
    expect(read).toEqual({ weakEnc: undefined, wrappedKey: undefined });
  });

  it("refuses a cookie its own key opens whose payload is not a session", async ({
    sessionCodecOf,
    forgeSession,
  }) => {
    // GIVEN sessions forged under the codec's own header and key, carrying the
    // payloads a real seal never writes
    const codec = (await sessionCodecOf({ keys: [sessionKeys.alpha] })).getOrThrow();
    const forged = (payload: unknown) =>
      forgeSession(sessionKeys.alpha, { alg: "dir", enc: "A256GCM" }, payload).flatMap(
        codec.unseal,
      );
    const read = {
      nothing: (await forged(null)).get(),
      stringExp: (await forged({ principal: {}, iat: 0, exp: "9999999999" })).get(),
      noPrincipal: (await forged({ iat: 0, exp: 4_102_444_800 })).get(),
    };

    // THEN all three are anonymous rather than a defect or a session that
    // coerced its way past the lifetime: the plaintext is authenticated, not
    // validated, so its shape is checked before it is trusted
    expect(read).toEqual({ nothing: undefined, stringExp: undefined, noPrincipal: undefined });
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

  it("names HTTP_SESSION_KEYS when a key is not base64url of 32 bytes", async ({
    sessionCodecOf,
  }) => {
    // GIVEN three bad key lists: one where nothing decodes, one where a good key
    // sits beside a short one, and one carrying a stray character that decodes
    // to 32 bytes anyway — the typo a length check waves through
    const messageOf = (built: Result<unknown, ConfigInvalid>): string =>
      built.isErr() ? built.error.message : "WRONGLY ACCEPTED";
    const typo = `${sessionKeys.alpha.slice(0, 20)}!${sessionKeys.alpha.slice(20)}`;

    // WHEN each is bound
    const built = {
      allBad: messageOf(await sessionCodecOf({ keys: ["short"] })),
      oneBad: messageOf(await sessionCodecOf({ keys: [sessionKeys.alpha, "short"] })),
      typo: messageOf(await sessionCodecOf({ keys: [typo] })),
    };

    // THEN each is a configuration error at boot — never a failure at the first
    // request — naming the variable and WHICH key of the list it refused, so an
    // operator holding three secrets knows which to re-mint, without the value
    // reaching a log
    const named = (position: string, of: number): string =>
      `HttpSession could not be configured:\n  HTTP_SESSION_KEYS: key ${position} of ${of} is not 32 base64url bytes (A-Z a-z 0-9 - _, no padding) — mint one with \`node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'\``;
    expect(built).toEqual({
      allBad: named("1", 1),
      oneBad: named("2", 2),
      typo: named("1", 1),
    });
  });
});
