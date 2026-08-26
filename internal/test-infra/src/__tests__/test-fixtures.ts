import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { test } from "vitest";

// Anchored the same way `lock.ts` anchors its own `LOCKS`, one directory
// deeper. A spec that computed this from `process.cwd()` would silently point
// somewhere else the moment vitest is run from the repository root.
const LOCKS = fileURLToPath(new URL("../../../../.cache/test-infra-locks/", import.meta.url));

type Lock = {
  /** A name nobody else holds, so a spec never queues behind a real test run. */
  readonly name: string;
  /** Leave a lock behind as `pid` would have, without going through `withLock`. */
  readonly plant: (pid: number) => void;
};

export const it = test.extend<{ lock: Lock; deadPid: number }>({
  lock: async ({}, use) => {
    const name = `spec-${randomUUID()}`;
    const path = `${LOCKS}${name}.lock`;
    await use({
      name,
      plant: (pid) => {
        mkdirSync(path, { recursive: true });
        writeFileSync(`${path}/pid`, String(pid), "utf8");
      },
    });
    rmSync(path, { recursive: true, force: true });
  },

  // A pid that is certainly not running, rather than one assumed too high to
  // exist: the ceiling differs between macOS and Linux, and a pid that happened
  // to be live would make the staleness test hang instead of fail.
  deadPid: async ({}, use) => {
    await use(spawnSync(process.execPath, ["-e", ""]).pid);
  },
});
