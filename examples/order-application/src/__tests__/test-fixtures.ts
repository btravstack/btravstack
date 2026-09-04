import { Env } from "@btravstack/config";
import { page } from "@btravstack/contract";
import { Module, Provider } from "@btravstack/di";
import {
  Customer,
  CustomerNotFound,
  DuplicateOrder,
  OrderNotFound,
  type Order,
  type TenantId,
  type CustomerId,
  type OrderId,
} from "@btravstack/example-order-domain";
import { observability, type Line, type Sink } from "@btravstack/observability";
import { ErrAsync, OkAsync } from "unthrown";
import { test } from "vitest";

import {
  CustomerApplicationModule,
  CustomerRepository,
  FindCustomer,
  FindOrder,
  ListOrders,
  OrderApplicationModule,
  MalformedCursor,
  OrderRepository,
  PlaceOrder,
  type OrderQuery,
} from "../index.js";

/**
 * The whole point of the layer split: the use cases run against stub
 * repositories provided by a module that exists only in this file. No database,
 * no HTTP, no kernel — the application layer is exercised with the
 * infrastructure hole still open, and `TestModule` compiles only because
 * providing both repositories (and importing a logger) is what closes the two
 * verticals' needs. One module here rather than two because one spec file
 * exercises each vertical and a fixture with two shapes would only be a
 * fixture with two shapes.
 */
const stubRepository = Provider(OrderRepository)({
  inject: {},
  sync: () => {
    // Keyed by tenant AND id, the way the real schema's composite unique key
    // is: a stub that ignored the tenant would let these specs pass against a
    // repository that leaks between tenants.
    const rows = new Map<string, Order>();
    const key = (tenantId: TenantId, id: string): string => `${tenantId}/${id}`;
    return {
      save: (tenantId: TenantId, order: Order) => {
        if (rows.has(key(tenantId, order.id)))
          return ErrAsync(new DuplicateOrder({ id: order.id }));
        rows.set(key(tenantId, order.id), order);
        return OkAsync(order);
      },
      find: (tenantId: TenantId, id: string) => {
        const row = rows.get(key(tenantId, id));
        return row === undefined
          ? ErrAsync(new OrderNotFound({ id: id as OrderId }))
          : OkAsync(row);
      },
      // Insertion-ordered, cursor = the order id: enough to page over in both
      // directions, and the real cursor arithmetic is `@unthrown/prisma`'s,
      // exercised against Postgres by examples/order-infrastructure.
      list: (tenantId: TenantId, { limit, after, before, minQuantity }: OrderQuery) => {
        const scoped = [...rows.entries()]
          .filter(([rowKey]) => rowKey.startsWith(`${tenantId}/`))
          .map(([, order]) => order)
          .filter((order) => minQuantity === undefined || order.quantity >= minQuantity);
        const at = (cursor: string) => scoped.findIndex((order) => order.id === cursor);
        // A cursor naming no row is `MalformedCursor`, exactly as the Prisma
        // adapter answers: `findIndex` would otherwise return -1 and page from
        // the start, so a stub that skipped this would let a spec pass on a
        // cursor the listing never issued.
        const anchor = before ?? after;
        if (anchor !== undefined && at(anchor) === -1)
          return ErrAsync(new MalformedCursor({ cursor: anchor }));
        // `before` takes the `limit` rows ENDING before the cursor, handed back
        // in the collection's own order — the previous page reads the way the
        // next one does, which is what the library's own backward page gives.
        const from =
          before !== undefined
            ? Math.max(0, at(before) - limit)
            : after === undefined
              ? 0
              : at(after) + 1;
        const to = before !== undefined ? at(before) : from + limit;
        const items = scoped.slice(from, to);
        return OkAsync(
          page(items, {
            previous: from > 0 ? (items[0]?.id ?? null) : null,
            next: to < scoped.length ? (items.at(-1)?.id ?? null) : null,
          }),
        );
      },
      remove: (tenantId: TenantId, id: string) =>
        rows.delete(key(tenantId, id))
          ? OkAsync()
          : ErrAsync(new OrderNotFound({ id: id as OrderId })),
    };
  },
});

/** One customer on hand, so the read side has something to answer with. */
const stubCustomerRepository = Provider(CustomerRepository)({
  inject: {},
  sync: () => {
    const rows = new Map([
      [
        "acme/0199a1e0-0000-7000-8000-0000000000c1",
        Customer.make({ id: "0199a1e0-0000-7000-8000-0000000000c1", name: "Ada" }).getOrThrow(),
      ],
    ]);
    return {
      find: (tenantId: TenantId, id: string) => {
        const row = rows.get(`${tenantId}/${id}`);
        return row === undefined
          ? ErrAsync(new CustomerNotFound({ id: id as CustomerId }))
          : OkAsync(row);
      },
    };
  },
});

/**
 * `observability()` binds its level from the `Env` port, which `start`
 * provides to every graph it boots — and there is no `start` here, so this
 * module provides an empty one itself. That is the only ceremony the real
 * logger costs a kernel-free spec, and it buys the very implementation the
 * deployments run.
 */
const testModuleWith = (sink: Sink) =>
  Module("Test")({
    imports: [
      OrderApplicationModule,
      CustomerApplicationModule,
      observability({ sink, level: "trace" }),
    ],
    provides: [stubRepository, stubCustomerRepository, Provider(Env)({ inject: {}, value: {} })],
    exports: [PlaceOrder, FindOrder, ListOrders, FindCustomer],
  });

/** A sink that keeps what it was given, so a spec asserts on the line's fields rather than on a string. */
const recorderOf = () => {
  const lines: Line[] = [];
  return { sink: (line: Line) => lines.push(line), lines: (): readonly Line[] => lines };
};

export type ApplicationFixtures = {
  /** Everything the graph's logger wrote during this test. */
  readonly recorder: ReturnType<typeof recorderOf>;
  /** Both verticals with all their needs closed: two in-memory stubs, and the observability starter. */
  readonly testModule: ReturnType<typeof testModuleWith>;
};

export const it = test.extend<ApplicationFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  recorder: async ({}, use) => {
    await use(recorderOf());
  },

  testModule: async ({ recorder }, use) => {
    await use(testModuleWith(recorder.sink));
  },
});
