// `resolve` is idempotent — the second SIGTERM, and the uncaught handler
// racing a signal, both call it again — so the flag below is internal to that
// guard. There is deliberately no `settled()` accessor: nothing in the kernel
// asks, and an unread accessor is dead code the compiler cannot see.
export type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

export const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let settled = false;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });

  return {
    promise,
    resolve: (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    },
  };
};
