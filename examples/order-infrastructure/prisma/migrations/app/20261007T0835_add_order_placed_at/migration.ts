#!/usr/bin/env -S node
import { Migration, MigrationCLI, col, fn, rawSql } from "@prisma/orm-postgres/migration";

import type { Contract as End } from "../../snapshots/6b6880623163b69ec9c16207eef60e9f93b04e372d407d5f76f7b765a19cbda9/contract";
import endContract from "../../snapshots/6b6880623163b69ec9c16207eef60e9f93b04e372d407d5f76f7b765a19cbda9/contract.json" with { type: "json" };
import type { Contract as Start } from "../../snapshots/6fd063c14cd2f74fbcd02a86c0480099d54d83e8d3231542ad1c7b41bbffa67f/contract";
import startContract from "../../snapshots/6fd063c14cd2f74fbcd02a86c0480099d54d83e8d3231542ad1c7b41bbffa67f/contract.json" with { type: "json" };

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: "orders",
        table: "order",
        column: col("placedAt", "timestamptz", {
          notNull: true,
          default: fn("now()"),
          codecRef: { codecId: "pg/timestamptz-string@1" },
        }),
      }),
      // `now()` alone would stamp every existing order with the migration's
      // time, and the sweep deletes by this column. An order's placement is
      // its LATEST surviving create in the outbox — an earlier one belongs to
      // a previous life of a reused id — and only an order with none left
      // keeps the default.
      rawSql({
        id: "backfill.order.placedAt",
        label:
          'Backfill "order"."placedAt" from each order\'s latest surviving placement outbox row; orders with none keep the migration time',
        operationClass: "additive",
        target: {
          id: "postgres",
          details: { schema: "orders", objectType: "column", name: "placedAt", table: "order" },
        },
        precheck: [
          {
            description: 'ensure "order"."placedAt" exists',
            sql: `SELECT EXISTS (SELECT 1 FROM "information_schema"."columns" WHERE "table_schema" = 'orders' AND "table_name" = 'order' AND "column_name" = 'placedAt') AS "result"`,
          },
        ],
        execute: [
          {
            description: "copy each order's latest placement time out of the outbox",
            sql: `UPDATE "orders"."order" AS o SET "placedAt" = placed."occurredAt" FROM (SELECT "tenantId", "subjectId", max("occurredAt") AS "occurredAt" FROM "orders"."outboxMessage" WHERE "kind" = 'order' AND "payload" IS NOT NULL GROUP BY "tenantId", "subjectId") AS placed WHERE placed."tenantId" = o."tenantId" AND placed."subjectId" = o."orderId"`,
          },
        ],
        postcheck: [
          {
            description: "verify no order with a surviving placement row kept the migration time",
            sql: `SELECT NOT EXISTS (SELECT 1 FROM "orders"."order" AS o JOIN (SELECT "tenantId", "subjectId", max("occurredAt") AS "occurredAt" FROM "orders"."outboxMessage" WHERE "kind" = 'order' AND "payload" IS NOT NULL GROUP BY "tenantId", "subjectId") AS placed ON placed."tenantId" = o."tenantId" AND placed."subjectId" = o."orderId" WHERE o."placedAt" <> placed."occurredAt") AS "result"`,
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
