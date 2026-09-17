#!/usr/bin/env -S node
import { Migration, MigrationCLI, col, fn, primaryKey } from "@prisma/orm-postgres/migration";

import type { Contract as End } from "../../snapshots/41301af477c07263d3c5f96992cac531933198d4ca09c28be19ceb23fae27232/contract";
import endContract from "../../snapshots/41301af477c07263d3c5f96992cac531933198d4ca09c28be19ceb23fae27232/contract.json" with { type: "json" };

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: "public" }),
      this.createTable({
        schema: "public",
        table: "customer",
        columns: [
          col("customerId", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("id", "SERIAL", { notNull: true, codecRef: { codecId: "pg/int4@1" } }),
          col("name", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("tenantId", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
        ],
        constraints: [primaryKey(["id"])],
      }),
      this.createTable({
        schema: "public",
        table: "order",
        columns: [
          col("id", "SERIAL", { notNull: true, codecRef: { codecId: "pg/int4@1" } }),
          col("orderId", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("quantity", "int4", { notNull: true, codecRef: { codecId: "pg/int4@1" } }),
          col("tenantId", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
        ],
        constraints: [primaryKey(["id"])],
      }),
      this.createTable({
        schema: "public",
        table: "outboxMessage",
        columns: [
          col("id", "SERIAL", { notNull: true, codecRef: { codecId: "pg/int4@1" } }),
          col("kind", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("occurredAt", "timestamptz", {
            notNull: true,
            default: fn("now()"),
            codecRef: { codecId: "pg/timestamptz-string@1" },
          }),
          col("payload", "text", { codecRef: { codecId: "pg/text@1" } }),
          col("publishedAt", "timestamptz", { codecRef: { codecId: "pg/timestamptz-string@1" } }),
          col("subjectId", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("tenantId", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
        ],
        constraints: [primaryKey(["id"])],
      }),
      this.addUnique({
        schema: "public",
        table: "customer",
        constraint: "customer_tenantId_customerId_key",
        columns: ["tenantId", "customerId"],
      }),
      this.addUnique({
        schema: "public",
        table: "order",
        constraint: "order_tenantId_orderId_key",
        columns: ["tenantId", "orderId"],
      }),
      this.enableRowLevelSecurity({ schema: "public", table: "order" }),
      this.createRlsPolicy({
        schema: "public",
        table: "order",
        policy: {
          naming: { kind: "wire", prefix: "order_tenant_isolation", hash: "c516f4ff" },
          tableName: "order",
          namespaceId: "public",
          operation: "all",
          roles: [],
          using: "\"tenantId\" = current_setting('app.tenant_id', true)",
          withCheck: "\"tenantId\" = current_setting('app.tenant_id', true)",
          permissive: true,
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
