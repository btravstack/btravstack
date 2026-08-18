import { mkdirSync, rmSync, statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/**
 * Gitignored, and repository-local rather than in the OS temp directory for
 * the same reason the Temporal binary's cache is: a lock that lives where the
 * repository lives is a lock a contributor can find and delete.
 */
const LOCKS = fileURLToPath(new URL("../../../.cache/test-infra-locks/", import.meta.url));

/**
 * A lock older than this was left behind by a process that died holding it —
 * every operation under one of these locks is a container start or a
 * migration, and none of them takes minutes.
 */
const STALE_MS = 5 * 60_000;

const WAIT_MS = 120_000;
const POLL_MS = 100;

/**
 * `mkdir` is the primitive: it either creates the directory or fails with
 * `EEXIST`, atomically, which is the whole of a mutex. Returns whether this
 * call is the one that took the lock.
 */
const tryTake = (path: string): boolean => {
  try {
    mkdirSync(path, { recursive: false });
    return true;
  } catch {
    return false;
  }
};

const isStale = (path: string): boolean => {
  try {
    return Date.now() - statSync(path).mtimeMs > STALE_MS;
  } catch {
    // Gone between the failed `mkdir` and this `stat` — whoever held it
    // released it, so the next `tryTake` is the one that decides.
    return false;
  }
};

/**
 * Hold `name` across **processes** while `run` executes.
 *
 * testcontainers' own reuse lock is an in-process mutex, so it does nothing
 * about the case this repository actually has: turbo starting several
 * workspaces' vitest runs at the same instant, each calling `withReuse()` on
 * the same container definition. Both fetch-by-label, both miss, both start
 * a container — which is the duplicate-container contention this whole module
 * exists to remove. A file lock is what makes "start it once" true across
 * processes.
 */
export const withLock = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
  mkdirSync(LOCKS, { recursive: true });
  const path = `${LOCKS}${name}.lock`;

  const deadline = Date.now() + WAIT_MS;
  while (!tryTake(path)) {
    if (isStale(path)) rmSync(path, { recursive: true, force: true });
    else if (Date.now() > deadline)
      // oxlint-disable-next-line unthrown/no-throw -- a vitest `globalSetup` reports failure by rejecting; there is no Result channel here, and a lock nobody released in two minutes must fail the run loudly rather than race
      throw new Error(
        `Timed out after ${WAIT_MS}ms waiting for the '${name}' test-infrastructure lock. If no other test run is active, delete ${path}.`,
      );
    else await delay(POLL_MS);
  }

  try {
    return await run();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
};
