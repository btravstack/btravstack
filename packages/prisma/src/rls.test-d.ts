// What `tenantScoped` promises at the type level: applying it costs a consumer
// nothing. Model delegates keep their own types, an EARLIER extension's client
// methods survive, and the `$transaction` it installs hands the callback a `tx`
// that is the extended client rather than an implicit `any`.
//
// The client is a structural stand-in rather than `PrismaClientExtends` from
// `@prisma/client/extension`: that type carries no model delegates and its
// `$extends` answers itself, so neither of the first two claims could be stated
// against it. A generated client cannot be imported here — there is one per
// application, which is the whole reason `prismaDatabase` takes a `client` arrow.
import { tenantScoped } from "./rls.js";

/** How Prisma resolves a `client` extension component onto the extended client. */
type Unthunk<C> = { [K in keyof C]: C[K] extends () => infer V ? V : never };

type Db = {
  readonly order: {
    readonly findMany: (args?: {
      readonly where?: { readonly tenantId: string };
    }) => Promise<readonly { readonly id: number }[]>;
  };
  /** An earlier extension's client method — `@unthrown/prisma`'s, in the example. */
  readonly $tryTransaction: <R>(fn: (tx: Db) => Promise<R>) => Promise<R>;
  readonly $extends: <A extends { client: Record<string, () => unknown> }>(
    define: (client: never) => { $extends: { extArgs: A } },
  ) => Db & Unthunk<A["client"]>;
};

declare const db: Db;

const scoped = db.$extends(tenantScoped("t"));

// 1. A model delegate keeps its own argument and result types.
const _rows: Promise<readonly { readonly id: number }[]> = scoped.order.findMany({
  where: { tenantId: "t" },
});

// 2. An earlier extension's client method survives.
const _tried: Promise<number> = scoped.$tryTransaction(
  async (tx) => (await tx.order.findMany()).length,
);

// 3. `$transaction`'s `tx` is the extended client. Without the cast in `rls.ts`
//    the implementation's own signature is what a consumer sees, and this line
//    fails with `TS7006: Parameter 'tx' implicitly has an 'any' type`.
const _counted: Promise<number> = scoped.$transaction(
  async (tx) => (await tx.order.findMany()).length,
);

// 4. …which is why an unknown member of `tx` is an error rather than free.
// @ts-expect-error - `tx` is typed, so `nope` does not exist on it
const _nope = scoped.$transaction(async (tx) => tx.nope());

// 5. The array form is absent from the type as well as refused at run time.
// @ts-expect-error - `$transaction([...])` is unsupported; use the callback form
const _batch = scoped.$transaction([Promise.resolve(1)]);
