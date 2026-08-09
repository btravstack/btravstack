import { AsyncLocalStorage } from "node:async_hooks";

export type UnitRecord = {
  readonly unitId: string;
  readonly traceId: string;
  readonly tenantId: string | undefined;
  readonly deadline: number | undefined;
};

const storage = new AsyncLocalStorage<UnitRecord>();

export const runWithUnit = <T>(record: UnitRecord, fn: () => T): T => storage.run(record, fn);

export const currentUnit = (): UnitRecord | undefined => storage.getStore();
