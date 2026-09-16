import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("ensureSchedule", () => {
  it("creates the schedule when the namespace has none", async ({ schedules }) => {
    // GIVEN a schedule id nobody has used
    // WHEN it is ensured once
    const outcome = await schedules.ensure({ cronExpressions: ["0 3 * * *"] });

    // THEN it was created
    expect(outcome).toBeOkWith("created");
  });

  it("brings an existing schedule up to date instead of failing", async ({ schedules }) => {
    // GIVEN a schedule already registered under this id — the ordinary state of
    // every deploy after the first
    // WHEN the same id is ensured again with a different spec
    const outcome = await schedules
      .ensure({ cronExpressions: ["0 3 * * *"] })
      .flatMap(() => schedules.ensure({ cronExpressions: ["0 4 * * *"] }));

    // THEN it reports the update rather than `ScheduleAlreadyExistsError`, and
    // the schedule now says what the code says — the failure mode a `try`/ignore
    // repair would have hidden is a cron that silently stopped matching
    expect(outcome).toBeOkWith("updated");
  });

  it("writes the spec it was given", async ({ schedules }) => {
    // GIVEN a schedule registered and then re-ensured with a new cron
    // WHEN the server is asked what it holds
    const described = await schedules
      .ensure({ cronExpressions: ["0 3 * * *"] })
      .flatMap(() => schedules.ensure({ cronExpressions: ["0 4 * * *"] }))
      .flatMap(() => schedules.describe());

    // THEN the second spec is what is registered, not the first
    expect(described).toBeOkWith(
      expect.objectContaining({
        spec: expect.objectContaining({
          calendars: expect.arrayContaining([
            expect.objectContaining({ hour: [expect.objectContaining({ start: 4 })] }),
          ]),
        }),
      }),
    );
  });

  it("reconciles the action's args, not only the spec", async ({ schedules }) => {
    // GIVEN a schedule registered with one argument, then ensured again with a
    // new cron AND a different argument
    const described = await schedules
      .ensure({ cronExpressions: ["0 3 * * *"] }, "first")
      .flatMap(() => schedules.ensure({ cronExpressions: ["0 4 * * *"] }, "second"))
      .flatMap(() => schedules.describe());

    // THEN both moved: a deploy that changed what the workflow is called with
    // used to answer `"updated"` while the server kept firing the old action
    expect(described).toBeOkWith(
      expect.objectContaining({
        spec: expect.objectContaining({
          calendars: expect.arrayContaining([
            expect.objectContaining({ hour: [expect.objectContaining({ start: 4 })] }),
          ]),
        }),
        action: expect.objectContaining({ args: ["second"] }),
      }),
    );
  });

  it("reconciles the policies, which drift as silently as the args did", async ({ schedules }) => {
    // GIVEN a schedule registered without one, then ensured again asking for it
    const described = await schedules
      .ensure({ cronExpressions: ["0 3 * * *"] })
      .flatMap(() =>
        schedules.ensure({ cronExpressions: ["0 3 * * *"] }, "x", { pauseOnFailure: true }),
      )
      .flatMap(() => schedules.describe());

    // THEN the server holds what the deploy asked for, rather than what the
    // first deploy to touch this id happened to say
    expect(described).toBeOkWith(
      expect.objectContaining({ policies: expect.objectContaining({ pauseOnFailure: true }) }),
    );
  });

  it("refuses args the schema rejects on the update path too, not only on create", async ({
    schedules,
  }) => {
    // GIVEN a schedule already registered, then ensured again with args its
    // workflow's input schema refuses
    // WHEN the second ensure runs, which is the `update` arm
    const outcome = await schedules
      .ensure({ cronExpressions: ["0 3 * * *"] })
      .flatMap(() => schedules.ensureInvalid({ cronExpressions: ["0 4 * * *"] }));

    // THEN the typed handle checked them before anything was persisted — which
    // is what makes writing the action safe, and the old rationale wrong
    expect(outcome).toBeErrTagged("@temporal-contract/WorkflowValidationError");
  });

  it("passes a workflow the contract never declared through, still typed", async ({
    schedules,
  }) => {
    // GIVEN a workflow name reached past the types — a widened contract, or a
    // JavaScript caller
    // WHEN it is ensured
    const outcome = await schedules.ensureUnknown({ cronExpressions: ["0 3 * * *"] });

    // THEN it is the library's own error on the channel, not a schedule
    // recovered into existence: only the already-exists case is recovered here
    expect(outcome).toBeErrTagged("@temporal-contract/WorkflowNotInContractError");
  });

  it("passes args the workflow's schema refuses through, still typed", async ({ schedules }) => {
    // GIVEN args the contract's input schema rejects
    // WHEN they are ensured
    const outcome = await schedules.ensureInvalid({ cronExpressions: ["0 3 * * *"] });

    // THEN validation happens before anything reaches Temporal, and the error
    // survives with its own tag
    expect(outcome).toBeErrTagged("@temporal-contract/WorkflowValidationError");
  });
});
