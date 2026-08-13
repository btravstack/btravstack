import {
  tagPatterns,
  WORKFLOW_RESULT_ERROR_TAGS,
  WORKFLOW_START_ERROR_TAGS,
} from "@temporal-contract/client";
import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("the fulfillment saga", () => {
  it("fulfills an order: place, reserve, ship, in order", async ({ serve, fulfilling }) => {
    // GIVEN the same composition `main.ts` boots, under the time-skipping env
    const { client } = await serve(fulfilling.module);

    // WHEN the workflow is driven to completion
    // THEN the order came back through a real Workflow Task, three real
    // Activity Tasks, and the use case and services behind them
    await expect(
      client.executeWorkflow("fulfillOrder", {
        workflowId: "wf-fulfill-1",
        args: { orderId: "o-1", quantity: 2 },
      }),
    ).toBeOkWith({ id: "o-1", quantity: 2 });

    // AND the journey ran in the declared order, each step a log line — the
    // `[workflowId]` prefix is the activity unit's trace, stripped here
    // because the order of the steps is the assertion, not the tracing
    const { repository, logger } = fulfilling.services();
    expect(logger.lines().map((line) => line.slice(line.indexOf("]") + 2))).toEqual([
      "placing order o-1 (quantity 2)",
      "reserved 2 items for order o-1",
      "arranged shipping for order o-1",
    ]);

    // AND the placement is durably there
    await expect(repository.find("o-1")).toBeOkWith(
      expect.objectContaining({ id: "o-1", quantity: 2 }),
    );
  });

  it("compensates a stock refusal: the placement is walked back", async ({ serve, outOfStock }) => {
    // GIVEN stock that answers a permanent no
    const { client } = await serve(outOfStock.module);

    // WHEN the workflow runs
    const outcome = await client
      .executeWorkflow("fulfillOrder", {
        workflowId: "wf-oos-1",
        args: { orderId: "o-2", quantity: 5 },
      })
      .match({
        ok: () => "WRONGLY FULFILLED",
        // THEN the client can branch on the refusal by name — the saga's
        // answer is a typed contract error, not a broken execution
        errCases: (matcher) =>
          matcher
            .with({ errorName: "OutOfStock" }, (error) => `out-of-stock:${error.data.id}`)
            .with({ errorName: "InvalidQuantity" }, () => "WRONG ERROR")
            .with({ errorName: "OrderAlreadyPlaced" }, () => "WRONG ERROR")
            .with({ errorName: "ShippingUnavailable" }, () => "WRONG ERROR")
            .with(...tagPatterns(WORKFLOW_START_ERROR_TAGS), (error) => `start:${error._tag}`)
            .with(...tagPatterns(WORKFLOW_RESULT_ERROR_TAGS), (error) => `result:${error._tag}`),
        defect: () => "DEFECT",
      });
    expect(outcome).toBe("out-of-stock:o-2");

    // AND the placement the saga made before the refusal is gone — the
    // compensation ran, and the database agrees with the answer
    await expect(outOfStock.services().repository.find("o-2")).toBeErrTagged("OrderNotFound", {
      id: "o-2",
    });
  });

  it("compensates a shipping refusal in reverse order: release, then cancel", async ({
    serve,
    noShipping,
  }) => {
    // GIVEN shipping that answers a permanent no, and stock that records what
    // the saga asks of it
    const { client } = await serve(noShipping.module);

    // WHEN the workflow runs
    await expect(
      client.executeWorkflow("fulfillOrder", {
        workflowId: "wf-ship-1",
        args: { orderId: "o-3", quantity: 1 },
      }),
    ).toBeErr();

    // THEN the reservation was released — the walk-back reached the earlier
    // step, not just the placement
    expect(noShipping.released()).toEqual(["o-3"]);

    // AND the placement is gone too
    await expect(noShipping.services().repository.find("o-3")).toBeErrTagged("OrderNotFound", {
      id: "o-3",
    });
  });

  it("hands the client the OrderAlreadyPlaced the API answers CONFLICT for, as a typed contract error", async ({
    serve,
    fulfilling,
  }) => {
    // GIVEN an order already fulfilled by a first execution
    const { client } = await serve(fulfilling.module);

    // WHEN a second execution asks for the same order id — chained, so the
    // first execution's result is consumed and a failure there cannot be
    // mistaken for the duplicate
    const outcome = await client
      .executeWorkflow("fulfillOrder", {
        workflowId: "wf-dup-1",
        args: { orderId: "o-4", quantity: 2 },
      })
      .flatMap(() =>
        client.executeWorkflow("fulfillOrder", {
          workflowId: "wf-dup-2",
          args: { orderId: "o-4", quantity: 2 },
        }),
      )
      .match({
        ok: () => "WRONGLY PLACED",
        // THEN the identical `Err` the oRPC runtime turns into an inferable
        // CONFLICT is here a **branchable value at the client**, rehydrated by
        // name with its payload intact.
        errCases: (matcher) =>
          matcher
            .with({ errorName: "OrderAlreadyPlaced" }, (error) => `conflict:${error.data.id}`)
            .with({ errorName: "InvalidQuantity" }, () => "WRONG ERROR")
            .with({ errorName: "OutOfStock" }, () => "WRONG ERROR")
            .with({ errorName: "ShippingUnavailable" }, () => "WRONG ERROR")
            .with(...tagPatterns(WORKFLOW_START_ERROR_TAGS), (error) => `start:${error._tag}`)
            .with(...tagPatterns(WORKFLOW_RESULT_ERROR_TAGS), (error) => `result:${error._tag}`),
        defect: () => "DEFECT",
      });

    expect(outcome).toBe("conflict:o-4");
  });
});
