export { createOrderApiClient, type OrderApiClient } from "./client.js";
export { OrderApi, orderRouter } from "./module.js";
export { RequestModule, RequestSpan } from "./request-scope.js";
export { slice as CustomersSlice } from "./slices/customers/module.js";
export { slice as OrdersSlice } from "./slices/orders/module.js";
