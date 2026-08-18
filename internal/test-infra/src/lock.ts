import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/**
 * Gitignored, and repository-local rather than in the OS temp directory for
 * the same reason a container's data would be: a lock that lives where the
 * repository lives is a lock a contributor can find and delete.
 */
const LOCKS = fileURLToPath(new URL("../../../.cache/test-infra-locks/", import.meta.url));

/**
 * How long a waiter is prepared to queue. Generous because the work under a
 * lock is a container start or `prisma migrate deploy` shelled out through
 * `pnpm exec`, and a cold image pull is minutes rather than seconds — a
 * waiter that gives up while the holder is still working takes down a run
 * that was about to succeed.
 */
const WAIT_MS = 600_000;

/**
 * The fallback staleness window, for a lock whose owning process is gone in a
 * way {@link alive} cannot see — another machine's, or a recycled pid. It is
 * deliberately well **under** {@link WAIT_MS}: a stale window longer than the
 * wait cannot self-heal, because every waiter gives up before the lock is
 * old enough to break. That ordering is what turned one killed holder into a
 * five-minute outage for the whole gate once.
 */
const STALE_MS = 120_000;

const POLL_MS = 100;

/** Whether the process that took a lock is still running. `signal 0` checks liveness without delivering anything. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * `mkdir` is the primitive: it either creates the directory or fails with
 * `EEXIST`, atomically, which is the whole of a mutex. The pid goes inside so
 * a waiter can tell a working holder from a dead one. Returns whether this
 * call is the one that took the lock.
 */
const tryTake = (path: string): boolean => {
  try {
    mkdirSync(path, { recursive: false });
    writeFileSync(`${path}/pid`, String(process.pid), "utf8");
    return true;
  } catch {
    return false;
  }
};

/**
 * A lock nobody is holding any more.
 *
 * The pid is what makes this quick rather than a five-minute wait: a holder
 * killed mid-work — turbo cancelling its siblings after another task failed,
 * a Ctrl-C — never reaches the `finally` that would release, so the
 * *liveness* of the process that wrote it is the honest signal, and the clock
 * is only the fallback for the cases it cannot answer.
 */
const isStale = (path: string): boolean => {
  try {
    const pid = Number(readFileSync(`${path}/pid`, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && !alive(pid)) return true;
    return Date.now() - statSync(path).mtimeMs > STALE_MS;
  } catch {
    // Gone, or half-written, between the failed `mkdir` and this read —
    // whoever held it is releasing, so the next `tryTake` is what decides.
    return false;
  }
};

/**
 * Hold `name` across **processes** while `run` executes.
 *
 * testcontainers' own reuse lock is an in-process mutex, so it does nothing
 * about the case this repository actually has: turbo starting several
 * workspaces' vitest runs at the same instant, each calling `withReuse()` on
 * the same container definition. Both fetch-by-label, both miss, both start a
 * container — which is the duplicate-container contention this whole module
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
      // oxlint-disable-next-line unthrown/no-throw -- a vitest `globalSetup` reports failure by rejecting; there is no Result channel here, and a lock nobody released in ten minutes must fail the run loudly rather than race
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
