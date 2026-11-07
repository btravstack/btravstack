import { TEMPORAL_TLS_FILES } from "@btravstack/internal-test-infra/temporal-tls-files";
import { OkAsync } from "unthrown";
import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { credentialsOf, reloading } from "./connection-security.js";

describe("coherent credential generations", () => {
  it("reads the current certificate and key together across an atomic Secret generation swap", async ({
    coherentCredentials,
  }) => {
    // GIVEN
    await coherentCredentials.arm(false);
    // WHEN
    const result = await credentialsOf("TemporalConfig", coherentCredentials.security).flatMap(
      coherentCredentials.inspect,
    );
    // THEN
    expect(result).toBeOkWith({ certificateCurrent: true, keyCurrent: true, swaps: 1 });
  });

  it("retries a generation removed while its credential files are being read", async ({
    coherentCredentials,
  }) => {
    // GIVEN
    await coherentCredentials.arm(true);
    // WHEN
    const result = await credentialsOf("TemporalConfig", coherentCredentials.security).flatMap(
      coherentCredentials.inspect,
    );
    // THEN
    expect(result).toBeOkWith({ certificateCurrent: true, keyCurrent: true, swaps: 1 });
  });

  it("connects with the coherent credential snapshot after the mounted generation changes", async ({
    coherentCredentials,
  }) => {
    // GIVEN
    await coherentCredentials.arm(false);
    // WHEN
    const result = await credentialsOf("TemporalConfig", coherentCredentials.security).flatMap(
      coherentCredentials.connect,
    );
    // THEN
    expect(result).toBeOkWith(coherentCredentials.namespace);
  });

  it("applies both certificate rotations successfully without exposing a torn intermediate pair", async ({
    coherentCredentials,
  }) => {
    // GIVEN
    const outcomes: string[] = [];
    const initial = (
      await credentialsOf("TemporalConfig", coherentCredentials.security)
    ).getOrThrow();
    coherentCredentials.own(
      reloading("TemporalConfig", coherentCredentials.security, initial, (next) =>
        OkAsync()
          .flatMap(() => coherentCredentials.connect(next))
          .map(() => undefined)
          .tap(() => outcomes.push("ok"))
          .tapFailure(() => outcomes.push("error")),
      ),
    );
    await coherentCredentials.install(TEMPORAL_TLS_FILES.rotated);
    await vi.waitUntil(() => outcomes.length === 1, { timeout: 10_000 });
    await coherentCredentials.arm(false);
    // WHEN
    const completed = await vi
      .waitUntil(() => outcomes.length === 2, { timeout: 10_000 })
      .then(
        () => true,
        () => false,
      );
    // THEN
    expect({ completed, outcomes, swaps: coherentCredentials.swaps() }).toEqual({
      completed: true,
      outcomes: ["ok", "ok"],
      swaps: 1,
    });
  });

  it("bounds retries and names the certificate files when every snapshot changes", async ({
    coherentCredentials,
  }) => {
    // GIVEN
    await coherentCredentials.churn();
    // WHEN
    const result = await credentialsOf("TemporalConfig", coherentCredentials.security);
    // THEN
    const outcome = result.match({
      ok: () => ({ tag: "Ok" }),
      errCases: (matcher) =>
        matcher.with({ _tag: "ConfigInvalid" }, ({ port, issues }) => ({
          tag: "Err",
          port,
          issues,
        })),
      defect: (cause) => ({ tag: "Defect", cause }),
    });
    expect({ outcome, swaps: coherentCredentials.swaps() }).toEqual({
      outcome: {
        tag: "Err",
        port: "TemporalConfig",
        issues: [
          { message: "changed while being read", path: ["TEMPORAL_TLS_CLIENT_CERT_PATH"] },
          { message: "changed while being read", path: ["TEMPORAL_TLS_CLIENT_KEY_PATH"] },
        ],
      },
      swaps: 3,
    });
  });
});
