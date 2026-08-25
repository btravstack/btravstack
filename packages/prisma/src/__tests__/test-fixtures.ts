import { test } from "vitest";

/** What the starter needs of a client: a pool it can close. Nothing else. */
export type StubClient = {
  readonly $disconnect: () => Promise<void>;
  readonly disconnected: () => number;
  readonly url: string;
};

export type Stub = {
  readonly client: (connectionString: string) => StubClient;
  readonly last: () => StubClient | undefined;
};

/**
 * A stand-in for a generated Prisma client, counting its own disconnects. The
 * starter owns the pool's lifecycle and nothing else, so a stub proves it —
 * a real client would be testing Prisma.
 */
export const it = test.extend<{ stub: Stub }>({
  stub: async ({}, use) => {
    let last: StubClient | undefined;
    let count = 0;
    await use({
      client: (url) => {
        const c: StubClient = {
          $disconnect: () => {
            count += 1;
            return Promise.resolve();
          },
          disconnected: () => count,
          url,
        };
        last = c;
        return c;
      },
      last: () => last,
    });
  },
});
