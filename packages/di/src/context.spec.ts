import { expect, test } from "vitest";

import { unsafeAdd, unsafeKeys } from "./context.js";
import { Context, Port } from "./index.js";

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

// The nullish fallbacks in `unsafeAdd` and `unsafeKeys` guard a value that did
// not come from `Context.empty()` — a forged one carries no entry in the
// module-private `WeakMap`. Unreachable through the build pipeline, which is
// why they need a test of their own.
test("reads a forged context as empty rather than throwing", () => {
  const forged = {} as Context<never>;

  expect({
    keys: [...unsafeKeys(forged)],
    added: unsafeAdd(forged, Logger, { log: () => "hi" }) !== undefined,
  }).toEqual({ keys: [], added: true });
});
