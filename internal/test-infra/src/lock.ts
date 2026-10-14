import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/**
 * Gitignored, and repository-local rather than in the OS temp directory for
 * the same reason a container's data would be: a lock that lives where the
 * repository lives is a lock a contributor can find and delete.
 */
const LOCKS = fileURLToPath(new URL("../../../.cache/test-infra-locks/", import.meta.url));

/**
 * How long a waiter is prepared to queue. Generous because a cold image pull is
 * minutes rather than seconds, and a waiter that gives up while the holder is
 * still working takes down a run that was about to succeed.
 */
const WAIT_MS = 600_000;

/**
 * The fallback staleness window, for a lock whose owner is gone in a way
 * {@link alive} cannot see. Deliberately well UNDER {@link WAIT_MS}: a stale
 * window longer than the wait cannot self-heal, because every waiter gives up
 * before the lock is old enough to break.
 */
const STALE_MS = 120_000;

const POLL_MS = 100;

/** How often a holder refreshes its lock's mtime, so only a lock nobody is refreshing ages past {@link STALE_MS}. */
const HEARTBEAT_MS = 10_000;

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
 * A lock nobody is holding any more. The pid is what makes this quick: a holder
 * killed mid-work never reaches the `finally` that would release, so process
 * LIVENESS is the honest signal and the clock only the fallback.
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
 * Moved aside before it is deleted, and judged again once it is: a waiter that
 * judged the lock stale may lose a race to another that already broke and
 * re-took it, and deleting in place would delete that live lock.
 */
const breakStale = (path: string): void => {
  const aside = `${path}.${randomUUID()}.stale`;
  try {
    renameSync(path, aside);
  } catch {
    return;
  }
  if (isStale(aside)) {
    rmSync(aside, { recursive: true, force: true });
    return;
  }
  try {
    renameSync(aside, path);
  } catch {
    // A third waiter took the name in the instant it was free; nothing is left to restore.
  }
};

/**
 * Hold `name` across **processes** while `run` executes.
 *
 * testcontainers' own reuse lock is in-process, which does nothing about the
 * case this repository has: turbo starting several workspaces' runs at the same
 * instant, each calling `withReuse()` on the same definition — both miss the
 * fetch-by-label and both start a container.
 */
export const withLock = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
  mkdirSync(LOCKS, { recursive: true });
  const path = `${LOCKS}${name}.lock`;

  const deadline = Date.now() + WAIT_MS;
  while (!tryTake(path)) {
    if (isStale(path)) breakStale(path);
    else if (Date.now() > deadline)
      // oxlint-disable-next-line unthrown/no-throw -- a vitest `globalSetup` reports failure by rejecting; there is no Result channel here, and a lock nobody released in ten minutes must fail the run loudly rather than race
      throw new Error(
        `Timed out after ${WAIT_MS}ms waiting for the '${name}' test-infrastructure lock. If no other test run is active, delete ${path}.`,
      );
    else await delay(POLL_MS);
  }

  const heartbeat = setInterval(() => {
    const now = new Date();
    try {
      utimesSync(path, now, now);
    } catch {
      // Gone already: the release below is about to run.
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    return await run();
  } finally {
    clearInterval(heartbeat);
    rmSync(path, { recursive: true, force: true });
  }
};
