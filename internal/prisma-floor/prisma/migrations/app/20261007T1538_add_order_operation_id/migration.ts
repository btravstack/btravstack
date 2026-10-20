#!/usr/bin/env -S node
import { Migration, MigrationCLI, col } from "@prisma/orm-postgres/migration";

import type { Contract as Start } from "../../snapshots/00456417fccbecdfffc0262cfd6d740e06cafd0766929a5a5ed2d6dd449567bd/contract";
import startContract from "../../snapshots/00456417fccbecdfffc0262cfd6d740e06cafd0766929a5a5ed2d6dd449567bd/contract.json" with { type: "json" };
import type { Contract as End } from "../../snapshots/436a74bb21a12037db8d08183331abd70aba4e06fada08f0164412501bd39483/contract";
import endContract from "../../snapshots/436a74bb21a12037db8d08183331abd70aba4e06fada08f0164412501bd39483/contract.json" with { type: "json" };

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
