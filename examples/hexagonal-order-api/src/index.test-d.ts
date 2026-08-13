/**
 * The compile-time half of this example: `Pool`'s privacy and the arity gate
 * that routes a resourceful graph through `Module.scoped`. Both are
 * compile-time guarantees, so — mirroring the library's own
 * `example.test-d.ts` — this file's bodies are type-checked (this package's
 * `test:types` script, `tsc --noEmit -p tsconfig.test-d.json`) but never
 * executed: `vitest.config.ts`'s `include` only matches `*.spec.ts`, so
 * `vitest run` never loads this file at all. That split matters more than
 * usual here — `ctx` below stands in for a `Context` that is never actually
 * built, and `Module.build` is never actually invoked on a resourceful
 * module. Running either for real would either assert something false (the
 * built runtime map genuinely holds `Pool`) or leak a connection nothing
 * would ever release.
 */
import { Module, type Context } from "@btravstack/di";
import { test } from "vitest";

import { GetOrder, Pool, makeAppModule, makePersistenceModule } from "./index.js";

test("an importer sees only GetOrder in the built context's type — Pool stays internal to Persistence", () => {
  const ctx = null as unknown as Context<GetOrder>;
  ctx.get(GetOrder);
  // @ts-expect-error Pool is provided by Persistence but never exported there, so no importer of App can name it
  ctx.get(Pool);
});

test("a resourceful persistence graph cannot be built with Module.build — only Module.scoped discharges Scope", () => {
  const resourceful = makeAppModule(makePersistenceModule());
  // @ts-expect-error UNSATISFIED DEPENDENCIES: Pool's acquire/release arm puts Scope in Needs, and only Module.scoped discharges it
  void Module.build(resourceful);
});
