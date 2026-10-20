#!/usr/bin/env -S node
import { Migration, MigrationCLI, rawSql } from "@prisma/orm-postgres/migration";

import type { Contract as End } from "../../snapshots/476a633a556c1e336c088ae2e185c7c5eb3fce24bd6c1e2d7e1f3e58a60d959e/contract";
import endContract from "../../snapshots/476a633a556c1e336c088ae2e185c7c5eb3fce24bd6c1e2d7e1f3e58a60d959e/contract.json" with { type: "json" };
import type { Contract as Start } from "../../snapshots/b449367e57cae35b33b11bfb11b78ee29d3a94235bf8425e3f56b2bb440e8c74/contract";
import startContract from "../../snapshots/b449367e57cae35b33b11bfb11b78ee29d3a94235bf8425e3f56b2bb440e8c74/contract.json" with { type: "json" };

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.alterColumnType({
        schema: "orders",
        table: "outboxMessage",
        column: "id",
        options: {
          qualifiedTargetType: "int8",
          formatTypeExpected: "bigint",
          rawTargetTypeForLabel: "int8",
        },
      }),
      // The column alone is not enough: `SERIAL` created its sequence `AS
      // integer`, which still stops at 2^31 - 1 under an int8 column.
      rawSql({
        id: "alterSequence.outboxMessage.id",
        label: 'Widen the sequence behind "outboxMessage"."id" to bigint',
        operationClass: "widening",
        target: {
          id: "postgres",
          details: { schema: "orders", objectType: "sequence", name: "outboxMessage_id_seq" },
        },
        precheck: [
          {
            description: 'ensure "outboxMessage"."id" is backed by a sequence',
            sql: `SELECT pg_get_serial_sequence('"orders"."outboxMessage"', 'id') IS NOT NULL AS "result"`,
          },
        ],
        execute: [
          {
            description: "alter the sequence to bigint",
            sql: `DO $$ BEGIN EXECUTE format('ALTER SEQUENCE %s AS bigint', pg_get_serial_sequence('"orders"."outboxMessage"', 'id')); END $$`,
          },
        ],
        postcheck: [
          {
            description: "verify the sequence is bigint",
            sql: `SELECT EXISTS (SELECT 1 FROM pg_sequence WHERE seqrelid = pg_get_serial_sequence('"orders"."outboxMessage"', 'id')::regclass AND seqtypid = 'bigint'::regtype) AS "result"`,
          },
        ],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
