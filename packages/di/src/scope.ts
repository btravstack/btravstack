/** Internal: only `createScope` (this file) and `ClosableFinalisers` below need the shape. */
type Finaliser = () => void | Promise<void>;

/** Reports a finaliser failure during close: which port's release rejected, and why. */
export type TeardownReporter = (portId: string, cause: unknown) => void;

/** Internal: `ClosableFinalisers` below is the shape callers actually see. */
type Finalisers = {
  readonly onStop: (portId: string, f: Finaliser) => void;
};

export type ClosableFinalisers = {
  readonly close: () => Promise<void>;
} & Finalisers;

/**
 * Finalisers run in reverse acquisition order, so a resource is always released
 * before whatever it was built from. A throwing finaliser is reported — via
 * `onTeardownError`, which portId-tags it — and swallowed rather than rethrown:
 * shutdown must not be abandoned half-way, and a failed close must not shadow
 * whatever failure triggered the unwind in the first place.
 */
export function createScope(
  onTeardownError: TeardownReporter = (portId, cause) =>
    console.error(`[di] finaliser for ${portId} failed during close`, cause),
): ClosableFinalisers {
  const finalisers: (readonly [string, Finaliser])[] = [];
  let closed = false;

  return {
    onStop: (portId, f) => void finalisers.push([portId, f]),
    close: async () => {
      if (closed) return;
      closed = true;
      for (const [portId, f] of finalisers.toReversed()) {
        try {
          // Teardown is ordered, not parallel: a finaliser may depend on one
          // registered before it still being up.
          // oxlint-disable-next-line no-await-in-loop
          await f();
        } catch (cause) {
          // Reported, never rethrown: shutdown must not be abandoned half-way, and
          // a failed close must not shadow the failure that caused the unwind.
          // The reporter itself is untrusted user code — if it throws, that must
          // be swallowed too (there is nowhere left to report a broken reporter
          // to), or a throwing `onTeardownError` would propagate out of this
          // loop exactly like an unguarded finaliser would: abandoning every
          // remaining release and turning `close()` into a rejected promise
          // that masks whatever failure triggered the unwind in the first place.
          try {
            onTeardownError(portId, cause);
          } catch {
            // Nowhere left to report a reporter failure — swallowed on purpose.
          }
        }
      }
    },
  };
}
