export { CustomerApplicationModule, OrderApplicationModule } from "./module.js";
export {
  CustomerRepository,
  FindCustomer,
  FindOrder,
  OrderRepository,
  Outbox,
  PaymentService,
  PlaceOrder,
  ShippingService,
  StockService,
  type OrderEvent,
} from "./ports.js";
