import { describe, test } from "vitest";

import { type Context, Port } from "../src/index.js";

class Logger extends Port("Logger")<{ readonly log: (msg: string) => void }> {}
class Clock extends Port("Clock")<{ readonly now: () => string }> {}

describe("Context", () => {
  test("get returns the service shape", () => {
    const ctx = null as unknown as Context<Logger>;
    const log: (msg: string) => void = ctx.get(Logger).log;
    void log;
  });

  test("reading an absent port is a compile error", () => {
    const ctx = null as unknown as Context<Logger>;
    // @ts-expect-error Clock is not in R
    ctx.get(Clock);
  });

  test("a richer context satisfies a consumer asking for less", () => {
    const rich = null as unknown as Context<Logger | Clock>;
    const narrow: Context<Logger> = rich;
    void narrow;
  });

  test("a narrower context does not satisfy a consumer asking for more", () => {
    const narrow = null as unknown as Context<Logger>;
    // @ts-expect-error Context is contravariant in R
    const rich: Context<Logger | Clock> = narrow;
    void rich;
  });
});
