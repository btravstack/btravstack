import { TenantId } from "@btravstack/example-order-domain";
import { uuidv7 } from "uuidv7";
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
      deploySchedules(env).map((second) => [first.ensured, second.ensured]),
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

  it("retires the sweep of a tenant the deploy no longer lists", async ({
    server,
    tenant,
    scheduled,
  }) => {
    // GIVEN a release that swept two tenants, both visible on the namespace
    const moved = TenantId(uuidv7());
    const env = (tenants: readonly string[]) => ({
      TEMPORAL_ADDRESS: server.address,
      TEMPORAL_NAMESPACE: server.namespace,
      SWEEP_TENANTS: tenants.join(","),
    });
    const first = await deploySchedules(env([tenant, moved]));
    await vi.waitUntil(async () => !first.isOk() || (await scheduled(moved)).length > 0, {
      timeout: 10_000,
    });

    // WHEN the next release lists only one of them
    const second = await deploySchedules(env([tenant]));

    // THEN the other tenant's destructive sweep was deleted, and the listed
    // one kept
    expect(
      second.map(({ ensured, retired }) => ({
        ensured,
        movedRetired: retired.includes(`sweep-stale-orders-${moved}`),
        keptRetired: retired.includes(`sweep-stale-orders-${tenant}`),
      })),
    ).toBeOkWith({ ensured: ["updated"], movedRetired: true, keptRetired: false });
  });
});
