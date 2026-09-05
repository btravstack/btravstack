import { OkAsync, type AsyncResult } from "unthrown";
import { describe, test } from "vitest";

import { type Equal } from "./__tests__/type-assert.js";
import { Module, Port, Provider, type Context } from "./index.js";

class Db extends Port("FDb")<{ readonly q: () => string }> {}
class RequestId extends Port("FRequestId")<{ readonly value: string }> {}
class Missing extends Port("FMissing")<{ readonly nope: true }> {}

const RequestModule = Module("Request")({
  needs: [Db],
  provides: [Provider(RequestId)({ inject: { db: Db }, sync: ({ db }) => ({ value: db.q() }) })],
  exports: [RequestId],
});

const NeedsMissing = Module("NeedsMissing")({
  needs: [Missing],
  provides: [Provider(RequestId)({ inject: { missing: Missing }, sync: () => ({ value: "x" }) })],
  exports: [RequestId],
});

/**
 * Same positional-inference trick `scoped.test-d.ts`/`build.test-d.ts` use:
 * a plain `const typed: AsyncResult<A, E> = forked` assignment only proves
 * the declared type is assignable *into* whatever `forked` actually
 * carries — it would stay green even if `A`/`E` silently widened to
 * `unknown`. Reading the literal type arguments back out pins the value.
 */
type ForkChannels<T> = T extends AsyncResult<infer A, infer E> ? readonly [A, E] : never;

describe("forkScope", () => {
  test("a request module whose needs the parent covers is accepted", () => {
    const parent = null as unknown as Context<Db>;
    const forked = Module.forkScope(parent, RequestModule, (ctx) => OkAsync(ctx.get(RequestId)));

    type Channels = ForkChannels<typeof forked>;
    const valueIsRequestIdService: Equal<Channels[0], { readonly value: string }> = true;
    // Negative control: pins the resolved value to the real service shape,
    // not a widened `unknown` that would pass regardless of what
    // `forkScope` actually resolves `use`'s callback result to.
    const valueIsNotUnknown: Equal<Channels[0], unknown> = false;
    const errorIsNever: Equal<Channels[1], never> = true;
    void forked;
    void valueIsRequestIdService;
    void valueIsNotUnknown;
    void errorIsNever;
  });

  test("the fork's context exposes both the parent's services and the module's own exports", () => {
    const parent = null as unknown as Context<Db>;
    const forked = Module.forkScope(parent, RequestModule, (ctx) => {
      // `Db` comes from the parent context; `RequestId` from the forked
      // module's own exports. Both compiling with no `@ts-expect-error`
      // is what proves `ctx`'s type is really `Context<PParent | X>`, not
      // just `Context<X>` (which would still let the "accepted" test above
      // pass, since that test only reads `RequestId`).
      const db = ctx.get(Db);
      const requestId = ctx.get(RequestId);
      return OkAsync({ db, requestId });
    });

    type Channels = ForkChannels<typeof forked>;
    const valueShape: Equal<
      Channels[0],
      {
        db: { readonly q: () => string };
        requestId: { readonly value: string };
      }
    > = true;
    void forked;
    void valueShape;
  });

  test("a request module needing a port the parent lacks does not compile", () => {
    const parent = null as unknown as Context<Db>;
    // @ts-expect-error unsatisfied dependency: Missing
    Module.forkScope(parent, NeedsMissing, (ctx) => OkAsync(ctx.get(RequestId)));
  });

  test("a seeded port satisfies a need the parent does not cover", () => {
    class Principal extends Port("FPrincipal")<{ readonly userId: string }> {}
    const NeedsPrincipal = Module("NeedsPrincipal")({
      needs: [Principal],
      provides: [
        Provider(RequestId)({
          inject: { principal: Principal },
          sync: ({ principal }) => ({ value: principal.userId }),
        }),
      ],
      exports: [RequestId],
    });
    const parent = null as unknown as Context<Db>;

    // Accepted: `Principal` is seeded, so it is supplied from outside the tree.
    const forked = Module.forkScope(parent, NeedsPrincipal, (ctx) => OkAsync(ctx.get(Principal)), {
      seed: [[Principal, { userId: "u" }]],
    });
    type Channels = ForkChannels<typeof forked>;
    const seededIsReadable: Equal<Channels[0], { readonly userId: string }> = true;
    void forked;
    void seededIsReadable;

    // Refused: the same module with no seed still owes `Principal`.
    // @ts-expect-error -- UNSATISFIED DEPENDENCIES: `Principal` is neither in the parent nor seeded
    Module.forkScope(parent, NeedsPrincipal, (ctx) => OkAsync(ctx.get(RequestId)));

    // Refused: a seed value of the wrong shape.
    Module.forkScope(parent, NeedsPrincipal, (ctx) => OkAsync(ctx.get(RequestId)), {
      // @ts-expect-error -- the seeded value must be the port's service
      seed: [[Principal, { nope: true }]],
    });
  });
});
