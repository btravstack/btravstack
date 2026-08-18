export { databaseConfig, openDatabase, type OrderDatabaseClient } from "./database.js";
export { CustomerPersistenceModule, OrderPersistenceModule } from "./module.js";
export { prismaCustomerRepository } from "./prisma-customer-repository.js";
export { prismaOrderRepository } from "./prisma-order-repository.js";
export { prismaOutbox } from "./prisma-outbox.js";
