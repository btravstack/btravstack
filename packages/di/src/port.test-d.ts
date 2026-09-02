import { describe, test } from "vitest";

import { Port, type ServiceOf } from "./index.js";

// The workspace's one `interface`, and it is the subject rather than a slip: a
// consumer's service type is often an interface, and a port has to carry one
// as faithfully as it carries a `type` — `ServiceOf` reading through a
// declaration-merged shape is what these assertions pin.
interface Clock {
  readonly now: () => string;
}

class SystemClock extends Port("SystemClock")<Clock> {}
class TestClock extends Port("TestClock")<Clock> {}
class Logger extends Port("Logger")<{ readonly log: (msg: string) => void }> {}

describe("Port identity is nominal", () => {
  test("two ports with the same shape but different ids do not unify", () => {
    const system = null as unknown as SystemClock;
    // @ts-expect-error a SystemClock is not a TestClock, despite an identical service shape
    const wrong: TestClock = system;
    void wrong;
  });

  test("a port is assignable to itself", () => {
    const system = null as unknown as SystemClock;
    const same: SystemClock = system;
    void same;
  });

  test("ServiceOf recovers the shape from the instance type and from the class", () => {
    const fromInstance: ServiceOf<Logger> = { log: () => {} };
    const fromClass: ServiceOf<typeof Logger> = { log: () => {} };
    void fromInstance;
    void fromClass;
  });

  test("ServiceOf rejects a shape that does not match", () => {
    // @ts-expect-error a Logger service has `log`, not `write`
    const wrong: ServiceOf<Logger> = { write: () => {} };
    void wrong;
  });
});
