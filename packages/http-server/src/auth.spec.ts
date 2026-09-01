import { ErrAsync, OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { Unauthenticated, granted, principalMiddleware, resolvePrincipal } from "./auth.js";

describe("an authenticated procedure", () => {
  it("hands the handler the identity its scheme resolves", async ({ rpcAuthed }) => {
    // GIVEN a client presenting a token the authenticator accepts
    const client = rpcAuthed.clientWith("good");

    // WHEN a marked procedure reads a field the contract declares nowhere —
    // the contract names no identity type, so `defineHttp`'s registry is the
    // only thing that could have typed it
    await expect(client.orders.whoami({ id: "o-1" })).resolves.toEqual({ userId: "u-good" });
  });

  it("answers 401 without the authenticator's reason, and never runs the handler", async ({
    rpcAuthed,
  }) => {
    // GIVEN a client presenting a token the authenticator rejects with a reason
    const client = rpcAuthed.clientWith("bad");

    // WHEN a marked procedure is called
    const call = client.orders.whoami({ id: "o-1" }).catch((cause: unknown) => cause);

    // THEN the request was refused, the reason stayed in the process, and the
    // handler was not entered
    await expect(
      call.then((error) => ({
        code: (error as { code: string }).code,
        message: (error as { message: string }).message,
        ran: rpcAuthed.handlerRuns(),
      })),
    ).resolves.toEqual({
      code: "UNAUTHORIZED",
      message: expect.not.stringContaining("not the good token"),
      ran: 0,
    });
  });

  it("collapses an authenticator's own defect to a 500, not a 401", async ({ rpcAuthed }) => {
    // GIVEN a client presenting the token the authenticator blows up on
    const client = rpcAuthed.clientWith("boom");

    // WHEN a marked procedure is called
    const call = client.orders.whoami({ id: "o-1" }).catch((cause: unknown) => cause);

    // THEN the bug is reported as a server error and the handler was not entered
    await expect(
      call.then((error) => ({
        code: (error as { code: string }).code,
        ran: rpcAuthed.handlerRuns(),
      })),
    ).resolves.toEqual({ code: "INTERNAL_SERVER_ERROR", ran: 0 });
  });

  it("serves an unmarked procedure with no credentials at all", async ({ rpcAuthed }) => {
    // GIVEN a client presenting nothing
    const client = rpcAuthed.clientWith(undefined);

    // WHEN an unmarked procedure is called
    // THEN it answers
    await expect(client.health.ping()).resolves.toEqual({ ok: true });
  });
});

describe("substituting one scheme's authenticator", () => {
  it("serves a caller the real table would refuse, without building the verifier", async ({
    rpcSubstituted,
  }) => {
    // GIVEN a hand-rolled composition providing a stub on the scheme's own
    // port — recomposition, not a second registry: the TokenTable-backed
    // authenticator is not in this graph at all
    const client = rpcSubstituted("not-in-any-table");

    // WHEN a marked procedure is called with a token only the stub accepts
    // THEN the stub named the caller
    await expect(client.orders.whoami({ id: "o-1" })).resolves.toEqual({ userId: "u-stub" });
  });
});

describe("an authenticator with dependencies of its own", () => {
  it("is built from the services it declared, and names the caller with them", async ({
    rpcVerified,
  }) => {
    // GIVEN a client presenting a token only the injected table knows
    const client = rpcVerified("keyed");

    // WHEN a marked procedure is called
    // THEN the authenticator resolved it through the dependency di gave it —
    // `defineHttp` bound the deps arm, and the need reached the graph
    await expect(client.orders.whoami({ id: "o-1" })).resolves.toEqual({ userId: "u-keyed" });
  });
});

describe("a contract marked at its root", () => {
  it("protects every leaf beneath it", async ({ rpcRootMarked }) => {
    // GIVEN a client presenting a token the authenticator rejects
    const client = rpcRootMarked.clientWith("bad");

    // WHEN the only procedure — marked by the root alone — is called
    const call = client.orders.whoami({ id: "o-1" }).catch((cause: unknown) => cause);

    // THEN the authenticator ran, refused, and the handler was never entered
    await expect(
      call.then((error) => ({
        code: (error as { code: string }).code,
        ran: rpcRootMarked.handlerRuns(),
      })),
    ).resolves.toEqual({ code: "UNAUTHORIZED", ran: 0 });
  });

  it("hands the principal to a leaf the root alone marked", async ({ rpcRootMarked }) => {
    // GIVEN a client presenting a token the authenticator accepts
    const client = rpcRootMarked.clientWith("good");

    // WHEN the only procedure is called
    // THEN the principal the authenticator resolved reached the handler
    await expect(client.orders.whoami({ id: "o-1" })).resolves.toEqual({ userId: "u-good" });
  });
});

describe("a contract marked at its root, served through a piece minted two levels below", () => {
  // The fold-vs-walk proof: `FragmentAt`'s compile-time fold (applied where
  // `rootMarkedDeepController` is minted, at "v1.orders") and `routerOf`'s
  // runtime `inherited` walk (seeded from the composed contract's own root)
  // must agree, or a piece below a mark would silently skip authentication.

  it("hands the principal to the piece", async ({ rpcRootMarkedDeep }) => {
    // GIVEN a client presenting a token the authenticator accepts
    const client = rpcRootMarkedDeep.clientWith("good");

    // WHEN the procedure two levels below the root mark is called
    // THEN the principal the authenticator resolved reached the handler —
    // proving the type-level fold and the runtime walk typed and protected the
    // same leaf
    await expect(client.v1.orders.whoami({ id: "o-1" })).resolves.toEqual({ userId: "u-good" });
  });

  it("refuses an unauthenticated call with the handler never entered", async ({
    rpcRootMarkedDeep,
  }) => {
    // GIVEN a client presenting a token the authenticator rejects
    const client = rpcRootMarkedDeep.clientWith("bad");

    // WHEN the procedure two levels below the root mark is called
    const call = client.v1.orders.whoami({ id: "o-1" }).catch((cause: unknown) => cause);

    // THEN the request was refused before the handler ran — the runtime walk
    // protected a leaf no `contract[key]` lookup at "v1.orders" itself marks
    await expect(
      call.then((error) => ({
        code: (error as { code: string }).code,
        ran: rpcRootMarkedDeep.handlerRuns(),
      })),
    ).resolves.toEqual({ code: "UNAUTHORIZED", ran: 0 });
  });
});

describe("a router over a marked contract", () => {
  it("declares the scheme's own port alongside the dependencies the caller wrote", ({
    authedRouterDeps,
  }) => {
    // GIVEN the same marked contract composed through both arms of OrpcRouter
    // WHEN each provider's declared dependencies are read
    // THEN the scheme's port joins both, named for the scheme and alongside —
    // never in place of — the caller's own
    expect(authedRouterDeps).toEqual({
      composed: ["OrpcController:orders", "OrpcController:health", "HttpAuthenticator:user"],
      fromDeps: ["Greeter", "HttpAuthenticator:user"],
    });
  });

  it("declares no scheme port when the contract marks nothing", ({ controllers }) => {
    // GIVEN a router composed from a controller over an unmarked contract
    // WHEN its declared dependencies are read
    // THEN nothing was appended — an application with no protected route provides nothing
    expect(controllers.unmarkedRouterDeps).toEqual([
      "OrpcController:greetings",
      "OrpcController:echoes.ping",
    ]);
  });
});

describe("a leaf naming several requirements", () => {
  it("takes the first requirement a caller satisfies", async ({ headers }) => {
    // GIVEN two schemes where only the second accepts this caller
    const middleware = principalMiddleware([{ user: [] }, { service: [] }], {
      user: () => ErrAsync(new Unauthenticated()),
      service: () => OkAsync({ appId: "a-1" }),
    });

    // WHEN a request arrives
    const injected = middleware({
      context: { request: { headers } as never },
      next: (o) => Promise.resolve(o.context.principal),
    });

    // THEN the second scheme's principal is injected, tagged because the leaf
    // names more than one
    await expect(injected).resolves.toEqual({ scheme: "service", identity: { appId: "a-1" } });
  });

  it("refuses with UNAUTHORIZED when no requirement is satisfied", async ({ headers }) => {
    // GIVEN a scheme that accepts nobody
    const middleware = principalMiddleware([{ user: [] }], {
      user: () => ErrAsync(new Unauthenticated()),
    });

    // WHEN a request arrives
    const refused = middleware({
      context: { request: { headers } as never },
      next: () => Promise.resolve(undefined),
    }).catch((error: unknown) => error);

    // THEN it is a 401 carrying no message a caller is not entitled to
    await expect(refused).resolves.toEqual(
      expect.objectContaining({
        code: "UNAUTHORIZED",
        message: expect.not.stringContaining("user"),
      }),
    );
  });

  it("admits a caller whose credential grants the scope the requirement names", async ({
    headers,
  }) => {
    // GIVEN an endpoint requiring a scope this credential does grant
    const middleware = principalMiddleware([{ user: ["orders:export"] }], {
      user: () => OkAsync(granted({ userId: "u-1" }, ["orders:read", "orders:export"])),
    });

    // WHEN a request arrives
    const injected = middleware({
      context: { request: { headers } as never },
      next: (o) => Promise.resolve(o.context.principal),
    });

    // THEN the identity is injected, bare — the leaf names one scheme, and the
    // scopes are checked rather than handed to the handler
    await expect(injected).resolves.toEqual({ userId: "u-1" });
  });

  it("injects a bare identity carrying a `scopes` field whole", async ({ headers }) => {
    // GIVEN a scheme declared with NO vocabulary whose identity happens to
    // carry claims-shaped scopes — the ordinary JWT shape
    const middleware = principalMiddleware([{ user: [] }], {
      user: () => OkAsync({ userId: "u-1", tenantId: "t-1", scopes: ["a"] }),
    });

    // WHEN a request arrives
    const injected = middleware({
      context: { request: { headers } as never },
      next: (o) => Promise.resolve(o.context.principal),
    });

    // THEN the whole identity reached the handler: reading the arm structurally
    // took this for the scoped answer and injected its absent `identity`
    await expect(injected).resolves.toEqual({
      userId: "u-1",
      tenantId: "t-1",
      scopes: ["a"],
    });
  });

  it("refuses with FORBIDDEN when the scheme grants no scopes at all", async ({ headers }) => {
    // GIVEN a requirement naming a scope against a scheme declared with no
    // vocabulary, which answers the identity BARE
    const middleware = principalMiddleware([{ user: ["orders:export"] }], {
      user: () => OkAsync({ userId: "u-1" }),
    });

    // WHEN a request arrives
    const refused = middleware({
      context: { request: { headers } as never },
      next: () => Promise.resolve(undefined),
    }).catch((error: unknown) => error);

    // THEN a credential reporting no scopes covers none of them — skipping the
    // comparison for a bare answer admitted the caller outright
    await expect(refused).resolves.toEqual(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("tags the principal when ONE requirement names two schemes", async ({ headers }) => {
    // GIVEN a single requirement naming two schemes — what `SchemesOf` unions,
    // and so what the handler was typed against
    const middleware = principalMiddleware([{ user: [], service: [] }], {
      user: () => ErrAsync(new Unauthenticated()),
      service: () => OkAsync({ appId: "a-1" }),
    });

    // WHEN a request arrives
    const injected = middleware({
      context: { request: { headers } as never },
      next: (o) => Promise.resolve(o.context.principal),
    });

    // THEN it is tagged: counting requirements rather than schemes would inject
    // bare here, and `principal.scheme` would read `undefined`
    await expect(injected).resolves.toEqual({ scheme: "service", identity: { appId: "a-1" } });
  });

  it("refuses with FORBIDDEN when the credential is valid but under-scoped", async ({
    headers,
  }) => {
    // GIVEN an endpoint requiring a scope the credential does not grant
    const middleware = principalMiddleware([{ user: ["orders:export"] }], {
      user: () => OkAsync(granted({ userId: "u-1" }, ["orders:read"])),
    });

    // WHEN a request arrives
    const refused = middleware({
      context: { request: { headers } as never },
      next: () => Promise.resolve(undefined),
    }).catch((error: unknown) => error);

    // THEN authenticated-but-insufficient is 403, not 401
    await expect(refused).resolves.toEqual(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("answers UnderScoped when the credential is valid but misses a scope", async ({ headers }) => {
    // GIVEN a scheme whose credential grants nothing, and a requirement naming a scope
    const authenticators = {
      user: () => OkAsync(granted({ userId: "u-1" }, [])),
    };

    // WHEN the walk is asked to resolve a principal for it
    const resolved = await resolvePrincipal([{ user: ["orders:export"] }], authenticators, headers);

    // THEN it is the under-scoped refusal, distinct from an anonymous one, so a
    // caller sees 403 rather than 401
    expect(resolved).toBeErrTagged("UnderScoped");
  });

  it("does not fall through to the next requirement on a defect", async ({ headers }) => {
    // GIVEN a first scheme whose authenticator is buggy and a second that accepts
    const boom = new Error("verifier exploded");
    const middleware = principalMiddleware([{ user: [] }, { service: [] }], {
      user: () =>
        OkAsync().map((): never => {
          // oxlint-disable-next-line unthrown/no-throw -- the subject under test: a defect is what a buggy authenticator produces, and `Defect` has no public constructor
          throw boom;
        }),
      service: () => OkAsync({ appId: "a-1" }),
    });

    // WHEN a request arrives
    const raised = middleware({
      context: { request: { headers } as never },
      next: () => Promise.resolve(undefined),
    }).catch((error: unknown) => error);

    // THEN the bug surfaces rather than silently promoting the caller to the
    // second scheme
    await expect(raised).resolves.toBe(boom);
  });
});
