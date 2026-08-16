// A promise's own `resolve` is idempotent by spec, so the second SIGTERM — and
// the uncaught handler racing a signal — cannot rewrite the reason an
// application stopped. Nothing here guards that; the platform does.
export type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

export const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });

  return { promise, resolve };
};
