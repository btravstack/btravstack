export { CustomerApplicationModule, OrderApplicationModule } from "./module.js";
export {
  CustomerRepository,
  FindCustomer,
  FindOrder,
  OrderRepository,
  Outbox,
  PlaceOrder,
  ShippingService,
  StockService,
  type OrderEvent,
} from "./ports.js";
