/**
 * Lifetime management: a connection pool acquired once, under `Module.scoped`,
 * and a per-request transaction layered over the already-built parent with
 * `Module.forkScope` — once per request. The parent survives every fork, each
 * fork releases only what it acquired, and it releases before the parent
 * does. `src/index.spec.ts` proves the release order empirically, not just
 * that the graph type-checks.
 */
import { Module, Port, Provider, type Context, type ServiceOf } from "@btravstack/di";
import { Ok, type AsyncResult, type Result } from "unthrown";

/**
 * The events a real system would emit as logs or metrics. Threading them
 * through an `onEvent` callback — rather than hard-coding `console.log` — is
 * what lets `src/index.spec.ts` observe lifecycle order without reaching
 * into anything private; a real caller would wire this to its own logger.
 */
export type LifecycleEvent = "pool-acquired" | "pool-released" | "txn-acquired" | "txn-released";

export class ConnectionPool extends Port("ConnectionPool")<{
  readonly id: string;
  readonly connect: () => string;
}> {}

export class Transaction extends Port("Transaction")<{
  readonly id: string;
  readonly run: (label: string) => string;
}> {}

const openPool = (): Result<ServiceOf<ConnectionPool>, never> => {
  const id = `pool-${crypto.randomUUID()}`;
  let connections = 0;
  return Ok({
    id,
    connect: () => {
      connections += 1;
      return `${id}/conn-${connections}`;
    },
  });
};

const beginTransaction = (
  pool: ServiceOf<ConnectionPool>,
): Result<ServiceOf<Transaction>, never> => {
  const id = `txn-${crypto.randomUUID()}`;
  const connection = pool.connect();
  return Ok({ id, run: (label) => `${connection}/${label}` });
};

/**
 * Built once per application, not once per request: `Module.scoped` opens
 * the scope this module's `ConnectionPool` provider registers its `release`
 * on, and holds it open for as long as the caller's `use` callback runs.
 */
export const makeAppModule = (onEvent: (event: LifecycleEvent) => void) =>
  Module("App")({
    provides: [
      Provider(ConnectionPool)({
        acquire: () => {
          onEvent("pool-acquired");
          return openPool();
        },
        release: () => void onEvent("pool-released"),
      }),
    ],
    exports: [ConnectionPool],
  });

/**
 * Built fresh for every request: `Transaction` depends on `ConnectionPool`,
 * which this module does not itself provide — `Module.forkScope` resolves it
 * from the already-built parent context instead, which is the entire point
 * of forking over a *built* parent rather than an empty one.
 */
export const makeRequestModule = (onEvent: (event: LifecycleEvent) => void) =>
  Module("Request")({
    provides: [
      Provider(Transaction)([ConnectionPool], {
        acquire: (pool) => {
          onEvent("txn-acquired");
          return beginTransaction(pool);
        },
        release: () => void onEvent("txn-released"),
      }),
    ],
    exports: [Transaction],
  });

/**
 * One request: forks a short-lived scope over the parent app context, runs
 * `work` against the transaction it constructs, and releases the
 * transaction — never the parent's pool — once `work` settles, whether it
 * succeeds or fails.
 */
export const handleRequest = <A, E>(
  appCtx: Context<ConnectionPool>,
  onEvent: (event: LifecycleEvent) => void,
  work: (txn: ServiceOf<Transaction>) => AsyncResult<A, E>,
): AsyncResult<A, E> =>
  Module.forkScope(appCtx, makeRequestModule(onEvent), (ctx) => work(ctx.get(Transaction)));
