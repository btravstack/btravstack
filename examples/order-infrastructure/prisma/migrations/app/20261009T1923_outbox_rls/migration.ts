#!/usr/bin/env -S node
import { Migration, MigrationCLI } from "@prisma/orm-postgres/migration";

import type { Contract as Start } from "../../snapshots/5a0d0ac6ae7ecae2b9a15aff710a54a298fafe18a15b437229136c4da7b1bafa/contract";
import startContract from "../../snapshots/5a0d0ac6ae7ecae2b9a15aff710a54a298fafe18a15b437229136c4da7b1bafa/contract.json" with { type: "json" };
import type { Contract as End } from "../../snapshots/825c736102bf93936e4342ba6551e6af179a30c5ae1bbc526e350e8219c5aa15/contract";
import endContract from "../../snapshots/825c736102bf93936e4342ba6551e6af179a30c5ae1bbc526e350e8219c5aa15/contract.json" with { type: "json" };

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
