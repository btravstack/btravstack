import type { Page } from "@btravstack/contract";
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

import type { MalformedCursor } from "./pagination.js";
import {
  CustomerRepository,
  FindCustomer,
  FindOrder,
  ListOrders,
  OrderRepository,
  PlaceOrder,
  Tenant,
  type OrderQuery,
} from "./ports.js";

class PlaceOrderInteractor {
  readonly #repository: ServiceOf<OrderRepository>;
  readonly #logger: ServiceOf<Logger>;
  readonly #tenant: ServiceOf<Tenant>;

  constructor({
    repository,
    logger,
    tenant,
  }: {
    readonly repository: ServiceOf<OrderRepository>;
    readonly logger: ServiceOf<Logger>;
    readonly tenant: ServiceOf<Tenant>;
  }) {
    this.#repository = repository;
    this.#logger = logger;
    this.#tenant = tenant;
  }

  execute(
    id: string,
    quantity: number,
  ): AsyncResult<Order, InvalidQuantity | InvalidOrderId | DuplicateOrder> {
    this.#logger.info("placing an order", { tenantId: this.#tenant, orderId: id, quantity });
    return placeOrder(id, quantity)
      .toAsync()
      .flatMap((order) => this.#repository.save(order));
  }
}

class FindOrderInteractor {
  readonly #repository: ServiceOf<OrderRepository>;

  constructor({ repository }: { readonly repository: ServiceOf<OrderRepository> }) {
    this.#repository = repository;
  }

  execute(id: string): AsyncResult<Order, OrderNotFound> {
    return this.#repository.find(id);
  }
}

class ListOrdersInteractor {
  readonly #repository: ServiceOf<OrderRepository>;

  constructor({ repository }: { readonly repository: ServiceOf<OrderRepository> }) {
    this.#repository = repository;
  }

  execute(query: OrderQuery): AsyncResult<Page<Order>, MalformedCursor> {
    return this.#repository.list(query);
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
  inject: { repository: OrderRepository, logger: Logger, tenant: Tenant },
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
