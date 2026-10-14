import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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

/** A pid, so a waiter can tell a working holder from a dead one, then a token naming this one acquisition. */
const ownerId = (): string => `${process.pid} ${randomUUID()}`;

const ownerOf = (dir: string): string | undefined => {
  try {
    return readFileSync(`${dir}/pid`, "utf8").trim();
  } catch {
    return undefined;
  }
};

/**
 * Only while `dir` still names `owner`: a holder or breaker that resumes after
 * being displaced — suspended past a staleness window — must not delete the
 * lock of whoever took it since. Returns whether it deleted.
 */
const releaseIfOwned = (dir: string, owner: string): boolean => {
  if (ownerOf(dir) !== owner) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
};

/**
 * `mkdir` is the primitive: it either creates the directory or fails with
 * `EEXIST`, atomically, which is the whole of a mutex. Returns whether this
 * call is the one that took the lock.
 */
const tryTake = (path: string, owner: string): boolean => {
  try {
    mkdirSync(path, { recursive: false });
    writeFileSync(`${path}/pid`, owner, "utf8");
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
    const pid = Number(readFileSync(`${path}/pid`, "utf8").trim().split(" ")[0]);
    if (Number.isInteger(pid) && pid > 0 && !alive(pid)) return true;
    return Date.now() - statSync(path).mtimeMs > STALE_MS;
  } catch {
    // Gone, or half-written, between the failed `mkdir` and this read —
    // whoever held it is releasing, so the next `tryTake` is what decides.
    return false;
  }
};

/**
 * A breaker is synchronous from taking its guard to releasing it, so a guard
 * older than this was left by a breaker killed inside that window.
 */
const GUARD_STALE_MS = 10_000;

/** Whether this call took `guard`; another breaker holding it is the only refusal that is not an error. */
const takeGuard = (guard: string, owner: string): boolean => {
  try {
    mkdirSync(guard);
    writeFileSync(`${guard}/pid`, owner, "utf8");
    return true;
  } catch (error) {
    // oxlint-disable-next-line unthrown/no-throw -- a guard that cannot be made for any reason but contention is a filesystem fault the run must fail on, not a wait to spin through
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const held = ownerOf(guard);
    try {
      if (held !== undefined && Date.now() - statSync(guard).mtimeMs > GUARD_STALE_MS)
        releaseIfOwned(guard, held);
    } catch {
      // Released between the failed `mkdir` and this read.
    }
    return false;
  }
};

/**
 * Whether it broke the lock. Deleted in place, never moved: the name stays occupied until the lock is
 * gone, so no waiter can take it while it is being judged. One breaker at a
 * time, and the lock judged again under the guard, because another breaker may
 * already have broken it and a third re-taken it since this one looked.
 */
const breakStale = (path: string): boolean => {
  const guard = `${path}.break`;
  const self = ownerId();
  if (!takeGuard(guard, self)) return false;
  try {
    const judged = ownerOf(path);
    return judged !== undefined && isStale(path) && releaseIfOwned(path, judged);
  } finally {
    releaseIfOwned(guard, self);
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

  const self = ownerId();
  const deadline = Date.now() + WAIT_MS;
  while (!tryTake(path, self)) {
    if (Date.now() > deadline)
      // oxlint-disable-next-line unthrown/no-throw -- a vitest `globalSetup` reports failure by rejecting; there is no Result channel here, and a lock nobody released in ten minutes must fail the run loudly rather than race
      throw new Error(
        `Timed out after ${WAIT_MS}ms waiting for the '${name}' test-infrastructure lock. If no other test run is active, delete ${path}.`,
      );
    if (!(isStale(path) && breakStale(path))) await delay(POLL_MS);
  }

  const heartbeat = setInterval(() => {
    const now = new Date();
    try {
      if (ownerOf(path) === self) utimesSync(path, now, now);
    } catch {
      // Gone already: the release below is about to run.
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    return await run();
  } finally {
    clearInterval(heartbeat);
    releaseIfOwned(path, self);
  }
};
