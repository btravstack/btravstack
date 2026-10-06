import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { deploySchedules } from "./schedules.js";

describe("deploy:schedules", () => {
  it("creates a tenant's sweep on the first deploy and updates it on the next", async ({
    server,
    tenant,
  }) => {
    // GIVEN the environment a release's deploy Job is handed
    const env = {
      TEMPORAL_ADDRESS: server.address,
      TEMPORAL_NAMESPACE: server.namespace,
      SWEEP_TENANTS: tenant,
    };

    // WHEN the deploy runs twice — what every release after the first is
    const outcomes = await deploySchedules(env).flatMap((first) =>
      deploySchedules(env).map((second) => [first, second]),
    );

    // THEN the second run found the first one's schedule and brought it up to
    // date, rather than failing on `ScheduleAlreadyExistsError`
    expect(outcomes).toBeOkWith([["created"], ["updated"]]);
  });

  it("leaves one schedule per tenant, however many times it runs", async ({
    server,
    tenant,
    scheduled,
  }) => {
    // GIVEN the same environment
    const env = {
      TEMPORAL_ADDRESS: server.address,
      TEMPORAL_NAMESPACE: server.namespace,
      SWEEP_TENANTS: tenant,
    };

    // WHEN the deploy runs twice, and the namespace's visibility has caught up
    const deployed = await deploySchedules(env).flatMap(() => deploySchedules(env));
    await vi.waitUntil(async () => !deployed.isOk() || (await scheduled(tenant)).length > 0, {
      timeout: 10_000,
    });

    // THEN the namespace holds exactly the one schedule the id names
    expect({ deployed: deployed.isOk(), scheduled: await scheduled(tenant) }).toEqual({
      deployed: true,
      scheduled: [`sweep-stale-orders-${tenant}`],
    });
  });
});
