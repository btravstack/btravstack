import { Module, Port, Provider, type ServiceOf } from "@btravstack/di";
import { currentUnit } from "@btravstack/start";
import { Err, Ok, TaggedError, type AsyncResult } from "unthrown";

export type Order = { readonly id: string; readonly quantity: number };

export class OrderNotFound extends TaggedError("OrderNotFound")<{
  readonly id: string;
}> {
  override message = `no order with id ${this.id}`;
}

export class DuplicateOrder extends TaggedError("DuplicateOrder")<{
  readonly id: string;
}> {
  override message = `order ${this.id} already exists`;
}

export class Logger extends Port("Logger")<{
  readonly info: (message: string) => void;
  readonly lines: () => readonly string[];
}> {}

export class OrderRepository extends Port("OrderRepository")<{
  readonly save: (order: Order) => AsyncResult<Order, DuplicateOrder>;
  readonly find: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}

export class PlaceOrder extends Port("PlaceOrder")<{
  readonly execute: (id: string, quantity: number) => AsyncResult<Order, DuplicateOrder>;
  readonly find: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}

export type Handler = (body: unknown) => AsyncResult<unknown, DuplicateOrder | OrderNotFound>;

export class Router extends Port("Router")<{
  readonly route: (method: string, path: string) => Handler | undefined;
}> {}

const loggerProvider = Provider(Logger)({
  sync: () => {
    const lines: string[] = [];
    return {
      info: (message: string) => lines.push(`[${currentUnit()?.traceId ?? "-"}] ${message}`),
      lines: () => lines,
    };
  },
});

const orderRepositoryProvider = Provider(OrderRepository)({
  sync: () => {
    const orders = new Map<string, Order>();
    return {
      save: (order) => {
        if (orders.has(order.id)) return Err(new DuplicateOrder({ id: order.id })).toAsync();
        orders.set(order.id, order);
        return Ok(order).toAsync();
      },
      find: (id) => {
        const order = orders.get(id);
        return order === undefined ? Err(new OrderNotFound({ id })).toAsync() : Ok(order).toAsync();
      },
    };
  },
});

class PlaceOrderInteractor {
  private readonly repository: ServiceOf<OrderRepository>;
  private readonly logger: ServiceOf<Logger>;

  constructor(repository: ServiceOf<OrderRepository>, logger: ServiceOf<Logger>) {
    this.repository = repository;
    this.logger = logger;
  }

  execute(id: string, quantity: number): AsyncResult<Order, DuplicateOrder> {
    this.logger.info(`placing order ${id}`);
    return this.repository.save({ id, quantity });
  }

  find(id: string): AsyncResult<Order, OrderNotFound> {
    return this.repository.find(id);
  }
}

const placeOrderProvider = Provider(PlaceOrder)([OrderRepository, Logger], {
  class: PlaceOrderInteractor,
});

class RouterImpl {
  private readonly placeOrder: ServiceOf<PlaceOrder>;

  constructor(placeOrder: ServiceOf<PlaceOrder>) {
    this.placeOrder = placeOrder;
  }

  route(method: string, path: string): Handler | undefined {
    if (method === "POST" && path === "/orders") {
      return (body) => {
        const { id, quantity } = body as { readonly id: string; readonly quantity: number };
        return this.placeOrder.execute(id, quantity);
      };
    }
    const orderIdMatch = /^\/orders\/([^/]+)$/.exec(path);
    if (method === "GET" && orderIdMatch !== null) {
      const id = orderIdMatch[1] as string;
      return () => this.placeOrder.find(id);
    }
    return undefined;
  }
}

const routerProvider = Provider(Router)([PlaceOrder], { class: RouterImpl });

export const AppModule = Module("App")({
  provides: [loggerProvider, orderRepositoryProvider, placeOrderProvider, routerProvider],
  exports: [Router, PlaceOrder, Logger],
});
