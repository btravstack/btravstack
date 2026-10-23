import { Config } from "@btravstack/config";
import { defineActivity, defineContract } from "@temporal-contract/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { taskQueueField } from "./task-queue.js";

describe("taskQueueField", () => {
  it.each(["", " ", "q".repeat(1001)])("rejects invalid deployment queues", (queue) => {
    // GIVEN
    const contract = defineContract({
      taskQueue: "protocol",
      workflows: {},
      activities: { echo: defineActivity({ input: z.string(), output: z.string() }) },
    });
    // WHEN
    const result = taskQueueField(contract).parse(queue);
    // THEN
    expect(result).toBeErrTagged("ConfigFieldInvalid");
  });

  it("validates pinned queues through the protocol library", () => {
    // GIVEN
    const contract = defineContract({
      taskQueue: "protocol",
      workflows: {},
      activities: { echo: defineActivity({ input: z.string(), output: z.string() }) },
    });
    // WHEN
    const result = Config.pinned("", taskQueueField(contract)).parse(undefined);
    // THEN
    expect(result).toBeErrTagged("ConfigFieldInvalid");
  });
});
