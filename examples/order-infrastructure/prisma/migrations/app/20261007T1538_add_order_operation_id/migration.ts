#!/usr/bin/env -S node
import { Migration, MigrationCLI, col } from "@prisma/orm-postgres/migration";

import type { Contract as End } from "../../snapshots/5a0d0ac6ae7ecae2b9a15aff710a54a298fafe18a15b437229136c4da7b1bafa/contract";
import endContract from "../../snapshots/5a0d0ac6ae7ecae2b9a15aff710a54a298fafe18a15b437229136c4da7b1bafa/contract.json" with { type: "json" };
import type { Contract as Start } from "../../snapshots/6b6880623163b69ec9c16207eef60e9f93b04e372d407d5f76f7b765a19cbda9/contract";
import startContract from "../../snapshots/6b6880623163b69ec9c16207eef60e9f93b04e372d407d5f76f7b765a19cbda9/contract.json" with { type: "json" };

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: "orders",
        table: "order",
        column: col("operationId", "text", { codecRef: { codecId: "pg/text@1" } }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
