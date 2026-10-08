import type { Page } from "@btravstack/contract";
import { Logger } from "@btravstack/core";
import { Provider } from "@btravstack/di";
import {
  placeOrder,
  type Customer,
  type CustomerNotFound,
  type DuplicateOrder,
  type InvalidOrderId,
  type InvalidQuantity,
  type Order,
  type OrderNotFound,
  type TenantId,
} from "@btravstack/example-order-domain";
import type { AsyncResult } from "unthrown";

import type { CursorSortMismatch, MalformedCursor } from "./pagination.js";
import { CustomerRepository, OrderRepository, Tenant, type OrderQuery } from "./ports.js";

/**
 * `operation` is handed to `OrderRepository.save` as it is: a caller that may
 * run the same placement more than once — an activity Temporal retries — names
 * it, so the repeat answers the order rather than `DuplicateOrder`. A named
 * field rather than a third positional `string`, so it cannot trade places
 * with the order id.
 */
export const placeOrderProvider = Provider("PlaceOrder")({
  inject: { repository: OrderRepository, logger: Logger, tenant: Tenant },
  sync: ({ repository, logger, tenant }) => ({
    execute: (
      id: string,
      quantity: number,
      { operation }: { readonly operation?: string | undefined } = {},
    ): AsyncResult<Order, InvalidQuantity | InvalidOrderId | DuplicateOrder> => {
      logger.info("placing an order", { tenantId: tenant, orderId: id, quantity });
      return placeOrder(id, quantity)
        .toAsync()
        .flatMap((order) => repository.save(order, operation));
    },
  }),
});
export const PlaceOrder = placeOrderProvider.port;
export type PlaceOrder = InstanceType<typeof PlaceOrder>;

export const findOrderProvider = Provider("FindOrder")({
  inject: { repository: OrderRepository },
  sync: ({ repository }) => ({
    execute: (id: string): AsyncResult<Order, OrderNotFound> => repository.find(id),
  }),
});
export const FindOrder = findOrderProvider.port;
export type FindOrder = InstanceType<typeof FindOrder>;

export const listOrdersProvider = Provider("ListOrders")({
  inject: { repository: OrderRepository },
  sync: ({ repository }) => ({
    execute: (query: OrderQuery): AsyncResult<Page<Order>, MalformedCursor | CursorSortMismatch> =>
      repository.list(query),
  }),
});
export const ListOrders = listOrdersProvider.port;
export type ListOrders = InstanceType<typeof ListOrders>;

export const findCustomerProvider = Provider("FindCustomer")({
  inject: { repository: CustomerRepository },
  sync: ({ repository }) => ({
    execute: (tenantId: TenantId, id: string): AsyncResult<Customer, CustomerNotFound> =>
      repository.find(tenantId, id),
  }),
});
export const FindCustomer = findCustomerProvider.port;
export type FindCustomer = InstanceType<typeof FindCustomer>;
