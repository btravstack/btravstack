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
export class PlaceOrder extends Provider.class("PlaceOrder", {
  inject: { repository: OrderRepository, logger: Logger, tenant: Tenant },
}) {
  execute(
    id: string,
    quantity: number,
    { operation }: { readonly operation?: string | undefined } = {},
  ): AsyncResult<Order, InvalidQuantity | InvalidOrderId | DuplicateOrder> {
    const { repository, logger, tenant } = this.deps;
    logger.info("placing an order", { tenantId: tenant, orderId: id, quantity });
    return placeOrder(id, quantity)
      .toAsync()
      .flatMap((order) => repository.save(order, operation));
  }
}

export class FindOrder extends Provider.class("FindOrder", {
  inject: { repository: OrderRepository },
}) {
  execute(id: string): AsyncResult<Order, OrderNotFound> {
    return this.deps.repository.find(id);
  }
}

export class ListOrders extends Provider.class("ListOrders", {
  inject: { repository: OrderRepository },
}) {
  execute(query: OrderQuery): AsyncResult<Page<Order>, MalformedCursor | CursorSortMismatch> {
    return this.deps.repository.list(query);
  }
}

export class FindCustomer extends Provider.class("FindCustomer", {
  inject: { repository: CustomerRepository },
}) {
  execute(tenantId: TenantId, id: string): AsyncResult<Customer, CustomerNotFound> {
    return this.deps.repository.find(tenantId, id);
  }
}
