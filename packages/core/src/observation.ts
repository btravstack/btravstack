import { Port } from "@btravstack/di";

import type { Attributes } from "./observability.js";

/**
 * One operation worth observing, named before it runs.
 *
 * `component` is the starter's own word for itself — `"http"`, `"cache"`,
 * `"amqp"` — and it is what lets an observer mint per-component instrument and
 * span names without knowing anything about the component. `name` is the
 * operation within it (`"get"`, `"unit"`), and `attributes` are the dimensions
 * known before the call.
 *
 * The dimensions are the contributor's business and their **cardinality is its
 * responsibility**: a request path or a workflow id here mints a time series
 * per value, which is how a metrics bill becomes the incident.
 */
export type Operation = {
  readonly component: string;
  readonly name: string;
  /**
   * The DIMENSIONS: bounded, and what a metrics observer may put on an
   * instrument. A cache operation, an HTTP method, an activity type.
   *
   * Their cardinality is the contributor's responsibility — a request path or a
   * cache key here mints a time series per value, which is how a metrics bill
   * becomes the incident. That is what {@link Operation.details} is for.
   */
  readonly attributes: Attributes;
  /**
   * Unbounded context: a cache key, a mail subject, a URL. It rides spans and
   * log lines, where one more field costs one more field — and **never a
   * metric**, where it would cost a time series per value.
   *
   * The split is the whole reason an observer can be shared: without it every
   * contributor would have to choose between a useful span and a safe metric.
   */
  readonly details?: Attributes;
  /**
   * Whether a tracing observer should open a span (default `true`).
   *
   * `false` is for a component whose spans already come from somewhere better:
   * `@btravstack/prisma` says so because `@prisma/instrumentation` traces at the
   * ENGINE level — the real SQL, the connection acquisition — all of it below
   * what a client-level wrapper can see, so a second span would cost one more
   * per query for strictly less information. Counting and timing still happen.
   *
   * Whether a span is worth opening is the CONTRIBUTOR's knowledge, which is
   * why it rides the operation rather than being configured on the observer.
   */
  readonly traced?: boolean;
};

/** How an operation came out, plus whatever was only knowable at the end. */
export type Settled = {
  readonly outcome: "ok" | "error";
  /** Dimensions known only at the end, merged over the operation's own — an HTTP status, a cache hit or miss. */
  readonly attributes?: Attributes;
  /** The failure itself, for an observer that writes a line about it. */
  readonly cause?: unknown;
};

/** What an observer answers: a finisher, called exactly once when the operation settles. */
export type Settle = (settled: Settled) => void;

/**
 * The set port a starter contributes its observability to, and reads whole.
 *
 * **Called at the START and answering a finisher**, rather than told about a
 * finished operation. That is what lets an observer open a span before the work
 * and end it after — a span reconstructed afterwards from a duration is not the
 * parent of anything that ran inside it.
 *
 * A set port rather than a `Meter` in every starter's `needs`: an observer
 * package an application never composed contributes nothing, and a starter
 * costs a graph no ports to have observability available. That is the
 * difference between "instrumented by default" and "instrumented if you asked
 * for observability", and only the second is free.
 *
 * **A module that reads this port contributes a no-op member of its own**, the
 * way `otel()` does for `Instrumentations`: a collector depending on a set port
 * NOTHING provides is an unmet dependency, at plan time and in `Needs` alike.
 * Several no-ops in one graph cost a call each and nothing else.
 */
export class Observers extends Port.many("Observers")<(operation: Operation) => Settle> {}

/** The no-op member every reader of {@link Observers} contributes, so the set is never empty. */
export const noObserver = (): Settle => () => {};

/**
 * Run every observer around one operation, and hand back the one finisher that
 * settles them all.
 *
 * Observers are started in order and settled in order, and the finisher is
 * **guarded**: a second call is dropped. "Called exactly once" is therefore a
 * property of this function rather than a rule each starter re-keeps — which
 * matters because the settling call sites are error paths, where a `tap` and a
 * `tapFailure` on the same chain, or a retry, is exactly the shape that fires
 * twice and doubles a failure count.
 */
export const observe = (
  observers: readonly ((operation: Operation) => Settle)[],
  operation: Operation,
): Settle => {
  const settlers = observers.map((observer) => observer(operation));
  let done = false;
  return (settled) => {
    if (done) return;
    done = true;
    for (const settle of settlers) settle(settled);
  };
};
