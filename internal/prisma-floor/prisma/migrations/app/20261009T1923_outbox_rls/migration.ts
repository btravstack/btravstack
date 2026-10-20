#!/usr/bin/env -S node
import { Migration, MigrationCLI } from "@prisma/orm-postgres/migration";

import type { Contract as Start } from "../../snapshots/436a74bb21a12037db8d08183331abd70aba4e06fada08f0164412501bd39483/contract";
import startContract from "../../snapshots/436a74bb21a12037db8d08183331abd70aba4e06fada08f0164412501bd39483/contract.json" with { type: "json" };
import type { Contract as End } from "../../snapshots/c567ea1d1ed315d6fd7fafe0fc8de090b0bda1cc14dc61cad722177719ef31f4/contract";
import endContract from "../../snapshots/c567ea1d1ed315d6fd7fafe0fc8de090b0bda1cc14dc61cad722177719ef31f4/contract.json" with { type: "json" };

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.enableRowLevelSecurity({ schema: "orders", table: "outboxMessage" }),
      this.createRlsPolicy({
        schema: "orders",
        table: "outboxMessage",
        policy: {
          naming: { kind: "wire", prefix: "outbox_tenant_isolation", hash: "c516f4ff" },
          tableName: "outboxMessage",
          namespaceId: "orders",
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
