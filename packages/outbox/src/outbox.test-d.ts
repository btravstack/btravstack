import { Temporal } from "temporal-polyfill";
import { describe, expectTypeOf, test } from "vitest";

import type { OutboxAppend } from "./memory.js";
import type { OutboxMessage } from "./outbox.js";

describe("outbox timestamp types", () => {
  test("preserves instants at the append and publisher boundaries", () => {
    expectTypeOf<OutboxMessage["occurredAt"]>().toEqualTypeOf<Temporal.Instant>();
    expectTypeOf<OutboxAppend["occurredAt"]>().toEqualTypeOf<Temporal.Instant | undefined>();
    // @ts-expect-error Date loses sub-millisecond precision
    const occurredAt: OutboxMessage["occurredAt"] = new Date();
    void occurredAt;
  });
});
