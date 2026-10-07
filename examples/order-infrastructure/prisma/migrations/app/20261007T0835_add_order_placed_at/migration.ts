#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/00456417fccbecdfffc0262cfd6d740e06cafd0766929a5a5ed2d6dd449567bd/contract';
import endContract from '../../snapshots/00456417fccbecdfffc0262cfd6d740e06cafd0766929a5a5ed2d6dd449567bd/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/476a633a556c1e336c088ae2e185c7c5eb3fce24bd6c1e2d7e1f3e58a60d959e/contract';
import startContract from '../../snapshots/476a633a556c1e336c088ae2e185c7c5eb3fce24bd6c1e2d7e1f3e58a60d959e/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'orders',
        table: 'order',
        column: col('placedAt', 'timestamptz', {
          notNull: true,
          default: fn('now()'),
          codecRef: { codecId: 'pg/timestamptz-string@1' },
        }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
