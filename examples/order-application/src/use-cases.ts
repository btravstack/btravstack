import { Logger } from "@btravstack/core";
import { Provider, type ServiceOf } from "@btravstack/di";
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

import type { MalformedCursor, Page } from "./pagination.js";
import {
  CustomerRepository,
  FindCustomer,
  FindOrder,
  ListOrders,
  OrderRepository,
  PlaceOrder,
  type OrderQuery,
} from "./ports.js";

class PlaceOrderInteractor {
  readonly #repository: ServiceOf<OrderRepository>;
  readonly #logger: ServiceOf<Logger>;

  constructor({
    repository,
    logger,
  }: {
    readonly repository: ServiceOf<OrderRepository>;
    readonly logger: ServiceOf<Logger>;
  }) {
    this.#repository = repository;
    this.#logger = logger;
  }

  execute(
    tenantId: TenantId,
    id: string,
    quantity: number,
  ): AsyncResult<Order, InvalidQuantity | InvalidOrderId | DuplicateOrder> {
    this.#logger.info("placing an order", { tenantId, orderId: id, quantity });
    return placeOrder(id, quantity)
      .toAsync()
      .flatMap((order) => this.#repository.save(tenantId, order));
  }
}

class FindOrderInteractor {
  readonly #repository: ServiceOf<OrderRepository>;

  constructor({ repository }: { readonly repository: ServiceOf<OrderRepository> }) {
    this.#repository = repository;
  }

  execute(tenantId: TenantId, id: string): AsyncResult<Order, OrderNotFound> {
    return this.#repository.find(tenantId, id);
  }
}

class ListOrdersInteractor {
  readonly #repository: ServiceOf<OrderRepository>;

  constructor({ repository }: { readonly repository: ServiceOf<OrderRepository> }) {
    this.#repository = repository;
  }

  execute(tenantId: TenantId, query: OrderQuery): AsyncResult<Page<Order>, MalformedCursor> {
    return this.#repository.list(tenantId, query);
  }
}

class FindCustomerInteractor {
  readonly #repository: ServiceOf<CustomerRepository>;

  constructor({ repository }: { readonly repository: ServiceOf<CustomerRepository> }) {
    this.#repository = repository;
  }

  execute(tenantId: TenantId, id: string): AsyncResult<Customer, CustomerNotFound> {
    return this.#repository.find(tenantId, id);
  }
}

export const placeOrderProvider = Provider(PlaceOrder)({
  inject: { repository: OrderRepository, logger: Logger },
  class: PlaceOrderInteractor,
});

export const findOrderProvider = Provider(FindOrder)({
  inject: { repository: OrderRepository },
  class: FindOrderInteractor,
});

export const listOrdersProvider = Provider(ListOrders)({
  inject: { repository: OrderRepository },
  class: ListOrdersInteractor,
});

export const findCustomerProvider = Provider(FindCustomer)({
  inject: { repository: CustomerRepository },
  class: FindCustomerInteractor,
});
