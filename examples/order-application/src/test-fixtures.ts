import { Env } from "@btravstack/config";
import { Module, Provider } from "@btravstack/di";
import {
  Customer,
  CustomerNotFound,
  DuplicateOrder,
  OrderNotFound,
  type Order,
} from "@btravstack/example-order-domain";
import { observability, type Line, type Sink } from "@btravstack/observability";
import { ErrAsync, OkAsync } from "unthrown";
import { test } from "vitest";

import {
  CustomerApplicationModule,
  CustomerRepository,
  FindCustomer,
  FindOrder,
  OrderApplicationModule,
  OrderRepository,
  PlaceOrder,
} from "./index.js";

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
  sync: () => {
    const rows = new Map<string, Order>();
    return {
      save: (order: Order) => {
        if (rows.has(order.id)) return ErrAsync(new DuplicateOrder({ id: order.id }));
        rows.set(order.id, order);
        return OkAsync(order);
      },
      find: (id: string) => {
        const row = rows.get(id);
        return row === undefined ? ErrAsync(new OrderNotFound({ id })) : OkAsync(row);
      },
      remove: (id: string) => (rows.delete(id) ? OkAsync() : ErrAsync(new OrderNotFound({ id }))),
    };
  },
});

/** One customer on hand, so the read side has something to answer with. */
const stubCustomerRepository = Provider(CustomerRepository)({
  sync: () => {
    const rows = new Map([["c-1", Customer.make({ id: "c-1", name: "Ada" }).getOrThrow()]]);
    return {
      find: (id: string) => {
        const row = rows.get(id);
        return row === undefined ? ErrAsync(new CustomerNotFound({ id })) : OkAsync(row);
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
    provides: [stubRepository, stubCustomerRepository, Provider(Env)({ value: {} })],
    exports: [PlaceOrder, FindOrder, FindCustomer],
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
