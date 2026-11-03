import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("connection initialization", () => {
  it("should preserve both failures as a defect when SDK cleanup fails", async ({
    failedCleanup,
  }) => {
    // GIVEN
    const { initialization, cleanup } = failedCleanup;

    // WHEN
    const outcome = await failedCleanup.attempt();

    // THEN
    expect(outcome).toBeDefectWith(
      expect.objectContaining({
        constructor: AggregateError,
        errors: [initialization, cleanup],
        cause: initialization,
      }),
    );
  });

  it("should close every refused handshake before acquisition failure settles", async ({
    refusing,
  }) => {
    // GIVEN
    const attempts = [1, 2, 3];

    // WHEN
    const outcomes = await Promise.all(attempts.map(async () => refusing.attempt()));
    await vi.waitUntil(() => refusing.activeSessions() === 0);

    // THEN
    expect({
      outcomes: outcomes.map(({ tag }) => tag),
      requests: refusing.requests(),
      activeSessions: refusing.activeSessions(),
    }).toEqual({ outcomes: ["Err", "Err", "Err"], requests: 3, activeSessions: 0 });
  });

  it("should retain the endpoint and original protocol refusal", async ({ refusing }) => {
    // GIVEN
    const settings = refusing.settings;

    // WHEN
    const outcome = await refusing.attempt();

    // THEN
    expect(outcome).toBeErrWith(
      expect.objectContaining({
        _tag: "TemporalClientUnreachable",
        address: settings.address,
        cause: expect.objectContaining({
          cause: expect.objectContaining({ code: 7, details: "fixture refused" }),
        }),
      }),
    );
  });
});
