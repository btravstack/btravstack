import { fromSchema } from "@unthrown/standard-schema";
import { test, type TestAPI } from "vitest";

import { orderContract, type OrderContract } from "./contract.js";

type PlacedPayload = typeof orderContract.consumers.orderPlaced.message.payload;

export type ContractFixtures = {
  /** The contract itself, as any worker or publisher would take it. */
  readonly contract: OrderContract;
  /**
   * The contract's own message-payload schema, as a validator returning a
   * `Result` — what a caller holding nothing but this package can check a
   * payload with before it ever reaches a worker.
   */
  readonly validate: ReturnType<typeof fromSchema<PlacedPayload>>;
};

export const it: TestAPI<ContractFixtures> = test.extend<ContractFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  contract: async ({}, use) => {
    await use(orderContract);
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  validate: async ({}, use) => {
    // `fromSchema` is CURRIED — it takes the schema and hands back the validator.
    await use(fromSchema(orderContract.consumers.orderPlaced.message.payload));
  },
});
