import { expect, test } from "vitest";

import { unsafeAdd } from "../src/context.js";
import { Context, Port } from "../src/index.js";

class Logger extends Port("CtxLogger")<{ readonly log: () => string }> {}

test("a service added to a context is readable from it", () => {
  const ctx = unsafeAdd(Context.empty(), Logger, { log: () => "hi" });
  expect((ctx as Context<Logger>).get(Logger).log()).toBe("hi");
});

test("adding does not mutate the context it was derived from", () => {
  const empty = Context.empty();
  unsafeAdd(empty, Logger, { log: () => "hi" });
  expect(() => (empty as unknown as Context<Logger>).get(Logger)).toThrow(/no service/u);
});
