#!/usr/bin/env -S node
import { Migration, MigrationCLI, rawSql } from "@prisma/orm-postgres/migration";

import type { Contract as End } from "../../snapshots/6fd063c14cd2f74fbcd02a86c0480099d54d83e8d3231542ad1c7b41bbffa67f/contract";
import endContract from "../../snapshots/6fd063c14cd2f74fbcd02a86c0480099d54d83e8d3231542ad1c7b41bbffa67f/contract.json" with { type: "json" };
import type { Contract as Start } from "../../snapshots/73bf96714946eefc41a8200321542354e34429a0bef45877f589c4503fc68649/contract";
import startContract from "../../snapshots/73bf96714946eefc41a8200321542354e34429a0bef45877f589c4503fc68649/contract.json" with { type: "json" };

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
