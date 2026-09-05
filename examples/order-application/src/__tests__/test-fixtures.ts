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
  tenantOf,
  type OrderQuery,
} from "../index.js";

/** Every tenant's rows in one map, keyed the way the real schema's composite unique key is. */
type Store = Map<string, Order>;

/**
 * The whole point of the layer split: the use cases run against a stub
 * repository provided by a module that exists only in this file. No database,
 * no HTTP, no kernel — the application layer is exercised with the
 * infrastructure hole still open, and the scope below compiles only because
 * providing both repositories, a tenant and a logger is what closes the two
 * verticals' needs.
 *
 * The repository is built for ONE tenant, as the real adapter now is, and the
 * store outlives it — so two scopes over one store is what an isolation spec
 * opens, and a stub that ignored its tenant would let that spec pass against a
 * repository which leaks.
 */
const stubRepositoryFor = (rows: Store, tenantId: TenantId) =>
  Provider(OrderRepository)({
    inject: {},
    sync: () => {
      const key = (id: string): string => `${tenantId}/${id}`;
      const mine = (): readonly Order[] =>
        [...rows.entries()]
          .filter(([rowKey]) => rowKey.startsWith(`${tenantId}/`))
          .map(([, order]) => order);
      return {
        save: (order: Order) => {
          if (rows.has(key(order.id))) return ErrAsync(new DuplicateOrder({ id: order.id }));
          rows.set(key(order.id), order);
          return OkAsync(order);
        },
        find: (id: string) => {
          const row = rows.get(key(id));
          return row === undefined
            ? ErrAsync(new OrderNotFound({ id: id as OrderId }))
            : OkAsync(row);
        },
        // Insertion-ordered, cursor = the order id: enough to page over in both
        // directions, and the real cursor arithmetic is `@unthrown/prisma`'s,
        // exercised against Postgres by examples/order-infrastructure.
        list: ({ limit, after, before, minQuantity }: OrderQuery) => {
          const scoped = mine().filter(
            (order) => minQuantity === undefined || order.quantity >= minQuantity,
          );
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
        remove: (id: string) =>
          rows.delete(key(id)) ? OkAsync() : ErrAsync(new OrderNotFound({ id: id as OrderId })),
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
 * One tenant's scope, the shape a deployment's unit module has: the tenant
 * provided once, the vertical composed over it, and the repository bound to
 * it.
 *
 * `observability()` binds its level from the `Env` port, which `start`
 * provides to every graph it boots — and there is no `start` here, so this
 * module provides an empty one itself. That is the only ceremony the real
 * logger costs a kernel-free spec, and it buys the very implementation the
 * deployments run.
 */
const scopeWith = (rows: Store, sink: Sink) => (tenantId: TenantId) =>
  Module("Scope")({
    imports: [
      tenantOf(tenantId),
      OrderApplicationModule,
      CustomerApplicationModule,
      observability({ sink, level: "trace" }),
    ],
    provides: [
      stubRepositoryFor(rows, tenantId),
      stubCustomerRepository,
      Provider(Env)({ inject: {}, value: {} }),
    ],
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
  /**
   * Both verticals with all their needs closed, for the tenant named — two
   * scopes over the one store is what an isolation spec asserts across.
   */
  readonly scopeFor: (tenantId: TenantId) => ReturnType<ReturnType<typeof scopeWith>>;
};

export const it = test.extend<ApplicationFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  recorder: async ({}, use) => {
    await use(recorderOf());
  },

  scopeFor: async ({ recorder }, use) => {
    await use(scopeWith(new Map(), recorder.sink));
  },
});
