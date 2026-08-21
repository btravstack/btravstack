import { Module, type ScopedOptions } from "@btravstack/di";
// Side-effect import: brings `@unthrown/vitest`'s `toBeOkWith`/`toBeErrTagged`
// module augmentation of vitest's `Assertion` into this compilation — `tsc`
// only sees an ambient augmentation once some file in the program imports
// the module that declares it. Runtime registration is separate (this
// package's `vitest.config.ts` `setupFiles`); this import exists purely for
// `tsc --noEmit`, mirroring `@btravstack/di`'s own `provider.spec.ts`.
import "@unthrown/vitest";
import { expect, test } from "vitest";

import {
  GetOrder,
  InMemoryPersistenceModule,
  makeAppModule,
  makePersistenceModule,
} from "./index.js";

test("the production graph resolves a use case through its ports, and releases what it acquired", async () => {
  const teardownErrors: (readonly [string, unknown])[] = [];
  const options: ScopedOptions = {
    onTeardownError: (portId, cause) => void teardownErrors.push([portId, cause]),
  };

  const outcome = await Module.scoped(
    makeAppModule(makePersistenceModule()),
    (ctx) => ctx.get(GetOrder).execute("0199a1e0-0000-7000-8000-000000000001"),
    options,
  );

  expect(outcome).toBeOkWith({ id: "0199a1e0-0000-7000-8000-000000000001", total: 4_200 });
  // No teardown failures — proof the pool's `release` actually ran cleanly,
  // not just that the graph type-checked.
  expect(teardownErrors).toEqual([]);
});

test("an id the pool does not carry comes back as a modeled error, not an exception", async () => {
  const outcome = await Module.scoped(makeAppModule(makePersistenceModule()), (ctx) =>
    ctx.get(GetOrder).execute("does-not-exist"),
  );

  expect(outcome).toBeErrTagged("OrderNotFound", { id: "does-not-exist" });
});

test("the same application module builds against an in-memory adapter, with no Scope required", async () => {
  // `Module.build` — not `.scoped` — is the point: `InMemoryPersistenceModule`
  // has no resourceful provider, so `makeAppModule`'s `Needs` collapses to
  // `never` for this instantiation, and `Module.build`'s compile-time gate
  // accepts it with no extra argument. Swapping in `makePersistenceModule()`
  // here is a compile error, not a runtime surprise — see
  // `src/index.test-d.ts`.
  const built = await Module.build(makeAppModule(InMemoryPersistenceModule));

  expect(built).toBeOk();
  const order = built.isOk() ? await built.value.get(GetOrder).execute("anything") : undefined;
  expect(order).toBeOkWith({ id: "anything", total: 99 });
});
