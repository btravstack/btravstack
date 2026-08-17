import { fromSchema } from "@unthrown/standard-schema";
import { test, type TestAPI } from "vitest";

import { orderContract } from "./contract.js";

type FulfillOrderInput = typeof orderContract.workflows.fulfillOrder.input;
type ChargeOrderInput = typeof orderContract.workflows.chargeOrder.input;

export type ContractFixtures = {
  /**
   * The contract's own workflow-input schema, as a validator returning a
   * `Result` — what a caller holding nothing but this package can check a
   * payload with before it ever reaches a worker.
   */
  readonly validate: ReturnType<typeof fromSchema<FulfillOrderInput>>;
  /** The same, for the second workflow — a different vertical, its own schema. */
  readonly validateCharge: ReturnType<typeof fromSchema<ChargeOrderInput>>;
};

export const it: TestAPI<ContractFixtures> = test.extend<ContractFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  validate: async ({}, use) => {
    // `fromSchema` is CURRIED — it takes the schema and hands back the validator.
    await use(fromSchema(orderContract.workflows.fulfillOrder.input));
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  validateCharge: async ({}, use) => {
    await use(fromSchema(orderContract.workflows.chargeOrder.input));
  },
});
