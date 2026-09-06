import { Prisma } from "@prisma/client/extension";

/** Options of {@link tenantScoped}. */
export type TenantScopedOptions = {
  /**
   * The PostgreSQL run-time setting the policy reads. Defaults to
   * `app.tenant_id`, matching `current_setting('app.tenant_id', true)`.
   */
  readonly setting?: string;
};

/**
 * The client a pinned `$transaction` callback receives — the extended client
 * minus what a transaction cannot do, exactly as Prisma's own deny list has it.
 */
export type TransactionClient<C> = Omit<
  C,
  "$connect" | "$disconnect" | "$extends" | "$on" | "$use"
>;

/**
 * The `$transaction` a {@link tenantScoped} client exposes: the callback form
 * only, with `this` carrying the extended client through to `tx`.
 *
 * @remarks
 * The generic `this` is what keeps `tx` typed. The starter cannot name a
 * generated client, so the receiver is the only place that type can come from.
 * The array form is absent because it cannot be pinned atomically.
 */
export type ScopedTransaction = <C, R>(
  this: C,
  fn: (tx: TransactionClient<C>) => Promise<R>,
  options?: { maxWait?: number; timeout?: number; isolationLevel?: string },
) => Promise<R>;

/**
 * A Prisma client extension pinning every statement to `tenant` through a
 * transaction-local `set_config`, so a row-level-security policy reading
 * `current_setting('app.tenant_id', true)` sees it.
 *
 * @remarks
 * Apply it **last**: the transaction callback's `tx` comes from the client as
 * it stood when this extension was applied, so an extension added after this
 * one is invisible inside a transaction.
 *
 * `$transaction([...])` is refused — the reasoning is in
 * `packages/prisma/CLAUDE.md`. Use the callback form.
 *
 * @example
 * ```ts
 * const db = new PrismaClient({ adapter }).$extends(unthrownPrisma).$extends(tenantScoped(tenant));
 * ```
 */
export const tenantScoped = (tenant: string, options?: TenantScopedOptions) =>
  Prisma.defineExtension((client) => {
    const setting = options?.setting ?? "app.tenant_id";

    // The client BEFORE this extension, and every `set_config` goes through it:
    // that is what stops the `$allOperations` hook — which sees raw SQL too —
    // from seeing its own statement and recursing without bound. The cast is
    // structural: `defineExtension`'s parameter surfaces neither method.
    const bare = client as unknown as {
      $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number>;
      $transaction: (arg: unknown, options?: unknown) => Promise<unknown>;
    };
    const pin = () => bare.$executeRaw`SELECT set_config(${setting}, ${tenant}, true)`;

    return client.$extends({
      name: "tenantScoped",
      client: {
        $transaction: ((arg: unknown, txOptions?: unknown) => {
          if (Array.isArray(arg))
            return Promise.reject(
              new Error(
                "tenantScoped: $transaction([...]) is unsupported — use the callback form.",
              ),
            );
          const fn = arg as (tx: unknown) => Promise<unknown>;
          return bare.$transaction(async (tx: unknown) => {
            await (tx as typeof bare).$executeRaw`SELECT set_config(${setting}, ${tenant}, true)`;
            return fn(tx);
          }, txOptions);
          // Without this cast the implementation's own signature is what the
          // consumer sees, and every caller's `tx` degrades to an implicit `any`.
        }) as unknown as ScopedTransaction,
      },
      query: {
        $allOperations: ({ args, query }) =>
          // The cast restates the hook's own return type: it answers a plain
          // promise where Prisma's callback type wants the `query` result's.
          bare
            .$transaction([pin(), query(args)])
            .then((results) => (results as readonly unknown[])[1]) as ReturnType<typeof query>,
      },
    });
  });
