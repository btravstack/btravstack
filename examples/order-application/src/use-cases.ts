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

import {
  CustomerRepository,
  FindCustomer,
  FindOrder,
  OrderRepository,
  PlaceOrder,
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

export const findCustomerProvider = Provider(FindCustomer)({
  inject: { repository: CustomerRepository },
  class: FindCustomerInteractor,
});
