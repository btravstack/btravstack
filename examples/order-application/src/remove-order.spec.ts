import { Module } from "@btravstack/di";
import { TenantId } from "@btravstack/example-order-domain";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { OrderRepository, PlaceOrder } from "./index.js";

describe("OrderRepository.remove in memory", () => {
  it("leaves a new placement alone when an old operation compensates a reused id", async ({
    scopeFor,
  }) => {
    // GIVEN the old placement gone and the id placed under another operation
    const id = "0199a1e0-0000-7000-8000-000000000611";
    // WHEN the original compensation repeats
    const remaining = await Module.scoped(scopeFor(TenantId("acme")), (ctx) => {
      const place = ctx.get(PlaceOrder);
      const repository = ctx.get(OrderRepository);
      return place
        .execute(id, 1, { operation: "old-run" })
        .flatMap(() => repository.remove(id))
        .flatMap(() => place.execute(id, 9, { operation: "new-run" }))
        .flatMap(() =>
          repository
            .remove(id, { operation: "old-run" })
            .recoverErrCases((matcher) => matcher.with({ _tag: "OrderNotFound" }, () => undefined)),
        )
        .flatMap(() => repository.find(id));
    });
    // THEN the replacement is untouched
    expect(remaining).toBeOkWith({ id, quantity: 9 });
  });

  it("does not carry old ownership into an unowned reinsertion of the same Order", async ({
    scopeFor,
  }) => {
    // GIVEN a stored Order retained after its old placement is removed
    const tenant = TenantId("acme");
    const id = "0199a1e0-0000-7000-8000-000000000613";
    // WHEN the same instance is inserted without an operation in a new scope
    const remaining = await Module.scoped(scopeFor(tenant), (ctx) =>
      ctx.get(PlaceOrder).execute(id, 2, { operation: "old-run" }),
    )
      .flatMap((order) =>
        Module.scoped(scopeFor(tenant), (ctx) => {
          const repository = ctx.get(OrderRepository);
          return repository.remove(id).flatMap(() => repository.save(order));
        }),
      )
      .flatMap(() =>
        Module.scoped(scopeFor(tenant), (ctx) => {
          const repository = ctx.get(OrderRepository);
          return repository
            .remove(id, { operation: "old-run" })
            .recoverErrCases((matcher) => matcher.with({ _tag: "OrderNotFound" }, () => undefined))
            .flatMap(() => repository.find(id));
        }),
      );
    // THEN the old run cannot delete that unowned placement
    expect(remaining).toBeOkWith({ id, quantity: 2 });
  });

  it("keeps ownership per tenant when both store the same Order instance", async ({ scopeFor }) => {
    // GIVEN one Order instance saved in two tenants under different operations
    const acme = TenantId("acme");
    const globex = TenantId("globex");
    const id = "0199a1e0-0000-7000-8000-000000000614";
    // WHEN the first tenant's operation removes its placement from another scope
    const remaining = await Module.scoped(scopeFor(acme), (ctx) =>
      ctx.get(PlaceOrder).execute(id, 2, { operation: "acme-run" }),
    )
      .flatMap((order) =>
        Module.scoped(scopeFor(globex), (ctx) =>
          ctx.get(OrderRepository).save(order, "globex-run"),
        ),
      )
      .flatMap(() =>
        Module.scoped(scopeFor(acme), (ctx) =>
          ctx.get(OrderRepository).remove(id, { operation: "acme-run" }),
        ),
      )
      .flatMap(() => Module.scoped(scopeFor(globex), (ctx) => ctx.get(OrderRepository).find(id)));
    // THEN the first removal succeeded and the second tenant still holds its placement
    expect(remaining).toBeOkWith({ id, quantity: 2 });
  });

  it("removes its own placement and leaves a repeated compensation harmless", async ({
    scopeFor,
  }) => {
    // GIVEN a placement named by its operation
    const id = "0199a1e0-0000-7000-8000-000000000612";
    // WHEN its operation removes it twice
    const repeated = await Module.scoped(scopeFor(TenantId("acme")), (ctx) => {
      const repository = ctx.get(OrderRepository);
      return ctx
        .get(PlaceOrder)
        .execute(id, 1, { operation: "own-run" })
        .flatMap(() => repository.remove(id, { operation: "own-run" }))
        .flatMap(() => repository.remove(id, { operation: "own-run" }));
    });
    // THEN the first succeeded and the repeat reports absence
    expect(repeated).toBeErrTagged("OrderNotFound", { id });
  });
});
