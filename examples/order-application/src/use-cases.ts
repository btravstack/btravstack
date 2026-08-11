import { Provider, type ServiceOf } from "@btravstack/di";
import {
  placeOrder,
  type DuplicateOrder,
  type InvalidQuantity,
  type Order,
  type OrderNotFound,
} from "@btravstack/start-example-order-domain";
import type { AsyncResult } from "unthrown";

import { FindOrder, Logger, OrderRepository, PlaceOrder } from "./ports.js";

class PlaceOrderInteractor {
  readonly #repository: ServiceOf<OrderRepository>;
  readonly #logger: ServiceOf<Logger>;

  constructor(repository: ServiceOf<OrderRepository>, logger: ServiceOf<Logger>) {
    this.#repository = repository;
    this.#logger = logger;
  }

  execute(id: string, quantity: number): AsyncResult<Order, InvalidQuantity | DuplicateOrder> {
    this.#logger.info(`placing order ${id} (quantity ${quantity})`);
    return placeOrder(id, quantity)
      .toAsync()
      .flatMap((order) => this.#repository.save(order));
  }
}

class FindOrderInteractor {
  readonly #repository: ServiceOf<OrderRepository>;

  constructor(repository: ServiceOf<OrderRepository>) {
    this.#repository = repository;
  }

  execute(id: string): AsyncResult<Order, OrderNotFound> {
    return this.#repository.find(id);
  }
}

export const placeOrderProvider = Provider(PlaceOrder)([OrderRepository, Logger], {
  class: PlaceOrderInteractor,
});

export const findOrderProvider = Provider(FindOrder)([OrderRepository], {
  class: FindOrderInteractor,
});
