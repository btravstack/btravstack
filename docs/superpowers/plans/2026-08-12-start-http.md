# `@btravstack/start-http` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@btravstack/start-http`, a `Runtime` that owns an HTTP server's lifecycle — bind, one unit per request, a drain that actually stops accepting, and stop — and migrate `examples/order-api` onto it.

**Architecture:** One `node:http` server wrapped in the kernel's `Runtime` contract. The caller supplies a `(request, response, ctx, signal) => PromiseLike<unknown>` handler; the package owns everything around it. A request's unit closes when the **response** completes, not when the handler settles, which makes the kernel's "flush inside the unit" contract structural. No routing, no middleware, no `Result` → status mapping.

**Tech Stack:** TypeScript (ESM-first, `NodeNext`), `node:http` + `node:crypto` only, `@btravstack/start` / `@btravstack/di` / `unthrown` as peers, vitest + `@unthrown/vitest` matchers, tsdown for dual CJS/ESM, oxlint + oxfmt.

**Spec:** `docs/superpowers/specs/2026-08-12-start-http-design.md`

## Global Constraints

- **Zero runtime dependencies.** `node:` builtins only. `@btravstack/start`, `@btravstack/di` and `unthrown` are **peer** dependencies (the dual-copy hazard is real for di's port identity and unthrown's `isResult`).
- **`engines: { node: ">=20" }`** on the package. Do not use `Promise.withResolvers` (Node 22+).
- **TypeScript** `strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`, inherited from `@btravstack/tsconfig/base.json`. **Relative imports carry `.js`** — `import { x } from "./http-runtime.js"`.
- **oxlint rules are binding:** no `interface` (use `type`), no `any` (use `unknown`), and every `@unthrown/oxlint` rule including `no-throw`. A genuine exception carries a targeted `oxlint-disable-next-line` **with a reason**.
- **No `Result` may be produced and left unexamined.** Fold with `.match({ ok, errCases, defect })` rather than dropping.
- **Comment density: sparse.** Rationale lives in `CLAUDE.md` and the spec, not inline — except where a comment guards a specific line against a plausible "simplification".
- **All five test conventions bind** (this is new code, not the kernel's exempt legacy): `describe` is the first statement after imports; helpers are vitest fixtures in `src/test-fixtures.ts` exporting an extended `it`; teardown lives in the fixture, never `try`/`finally`; every test body carries `// GIVEN`, `// WHEN`, `// THEN`; one deep `expect` per test, never an assertion that can decline to run.
- **Coverage:** 100% lines and functions on `packages/start-http`, enforced.
- **The gate must stay green:** `pnpm format --check`, `pnpm lint`, `pnpm typecheck`, `pnpm knip`, `pnpm test`, `pnpm build`.
- **Conventional Commits.** Publishable changes need a changeset.
- Run scoped commands from the package: `cd packages/start-http && pnpm vitest run src/<file>.spec.ts`.

> **Known local failure, not yours:** `packages/start`'s `invariants.spec.ts` → _"binds 9000 when no probe port is given"_ fails on this machine because a proxy holds `127.0.0.1:9000`. It passes in CI. Ignore it; do not "fix" it.

---

## File Structure

| File                                           | Responsibility                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/start-http/package.json`             | Package manifest — peers, exports, scripts                               |
| `packages/start-http/tsconfig.json`            | Extends the shared base; `rootDir` `src`, `outDir` `dist`                |
| `packages/start-http/vitest.config.ts`         | `@unthrown/vitest` setup + 100% thresholds                               |
| `packages/start-http/src/http-runtime.ts`      | The whole runtime: bind, unit, drain, stop                               |
| `packages/start-http/src/index.ts`             | Public surface                                                           |
| `packages/start-http/src/test-fixtures.ts`     | Fixtures (`serve`, `gate`, `traced`, `keepAlive`, …) + the extended `it` |
| `packages/start-http/src/http-runtime.spec.ts` | The suite                                                                |
| `packages/start-http/README.md`                | Package docs, incl. _Writing a runtime_                                  |
| `examples/order-api/src/orpc-runtime.ts`       | **Deleted** — replaced by the package                                    |
| `examples/order-api/src/main.ts`               | Rewired onto `httpRuntime`                                               |

`http-runtime.ts` stays one file: bind/unit/drain/stop are one concept — a server's lifecycle — and splitting them would separate code that changes together. It should land around 200 lines.

---

### Task 1: Scaffold the package

**Files:**

- Create: `packages/start-http/package.json`, `packages/start-http/tsconfig.json`, `packages/start-http/vitest.config.ts`, `packages/start-http/src/index.ts`

**Interfaces:**

- Consumes: nothing
- Produces: a workspace `@btravstack/start-http` that the root gate discovers via `pnpm-workspace.yaml`'s `packages/*` glob

This is configuration, so it has no unit test; its verification is the gate itself.

- [ ] **Step 1: Create `packages/start-http/package.json`**

```json
{
  "name": "@btravstack/start-http",
  "version": "0.0.0",
  "description": "The HTTP runtime for @btravstack/start: one unit per request, and a drain that actually stops accepting",
  "keywords": [
    "http",
    "graceful-shutdown",
    "lifecycle",
    "runtime",
    "typescript",
    "unthrown"
  ],
  "homepage": "https://github.com/btravstack/start#readme",
  "bugs": { "url": "https://github.com/btravstack/start/issues" },
  "license": "MIT",
  "author": "Benoit TRAVERS <benoit.travers.fr@gmail.com>",
  "repository": {
    "type": "git",
    "url": "https://github.com/btravstack/start.git",
    "directory": "packages/start-http"
  },
  "files": ["dist"],
  "type": "module",
  "sideEffects": false,
  "main": "./dist/index.cjs",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.cts",
  "exports": {
    ".": {
      "import": {
        "types": "./dist/index.d.mts",
        "default": "./dist/index.mjs"
      },
      "require": {
        "types": "./dist/index.d.cts",
        "default": "./dist/index.cjs"
      }
    },
    "./package.json": "./package.json"
  },
  "scripts": {
    "build": "tsdown src/index.ts --format cjs,esm --dts --clean",
    "dev": "tsdown src/index.ts --format cjs,esm --dts --watch",
    "test": "vitest run --coverage",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@btravstack/tsconfig": "catalog:",
    "@types/node": "catalog:",
    "@unthrown/vitest": "catalog:",
    "@vitest/coverage-v8": "catalog:",
    "tsdown": "catalog:",
    "typescript": "catalog:",
    "unthrown": "catalog:",
    "vitest": "catalog:"
  },
  "peerDependencies": {
    "@btravstack/di": "^0.1.0",
    "@btravstack/start": "workspace:^",
    "unthrown": "^5.0.0"
  },
  "engines": { "node": ">=20" }
}
```

`@btravstack/di` and `@btravstack/start` are **peer** dependencies here but deliberately **not** dev ones yet: nothing in the scaffold imports them, and `pnpm knip` fails the gate on an unused devDependency. Task 2 adds them in the same commit as the code that imports them, which keeps every commit on the branch green.

`version` is `0.0.0` because changesets assigns the first real version. There is no `test:types` script and no `tsconfig.test-d.json`: this package ships no `*.test-d.ts` files, so `typecheck` is a plain `tsc --noEmit`.

- [ ] **Step 2: Create `packages/start-http/tsconfig.json`**

```json
{
  "extends": "@btravstack/tsconfig/base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "declarationMap": false,
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `packages/start-http/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["@unthrown/vitest"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.spec.ts", "src/test-fixtures.ts"],
    },
  },
});
```

The 100% `thresholds` the spec requires are **not** set here. `Serving` obliges Task 2 to write `drain` and `stop` the moment it constructs one, but their tests cannot arrive until Tasks 3 and 8 — so thresholds from Task 1 would leave six consecutive commits red and make a genuine coverage regression indistinguishable from the expected one. Task 8 turns them on, once every path is reachable by a test.

- [ ] **Step 4: Create a placeholder `packages/start-http/src/index.ts`**

```ts
export type HttpInfo = { readonly port: number };
```

- [ ] **Step 5: Install and verify the gate discovers the workspace**

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm format --check
```

Expected: all pass, and `pnpm typecheck` reports one more task than before.

- [ ] **Step 6: Commit**

```bash
git add packages/start-http pnpm-lock.yaml
git commit -m "chore(start-http): scaffold the package"
```

---

### Task 2: Bind, publish the port, and stop

**Files:**

- Create: `packages/start-http/src/http-runtime.ts`, `packages/start-http/src/test-fixtures.ts`, `packages/start-http/src/http-runtime.spec.ts`
- Modify: `packages/start-http/src/index.ts`

**Interfaces:**

- Consumes: `Runtime`, `RuntimeHost`, `Serving`, `RuntimeStartFailed` from `@btravstack/start`; `AnyPort`, `Context`, `Module`, `Port`, `Provider` from `@btravstack/di`
- Produces:
  - `httpRuntime<Needs extends AnyPort>(options: HttpOptions<Needs>): Runtime<Needs, HttpInfo>`
  - `HttpInfo = { readonly port: number }`
  - `HttpOptions<Needs>` = `{ port: number; hostname?: string; needs: readonly Needs[]; handler: HttpHandler<Needs> }`
  - `HttpHandler<Needs>` = `(request: IncomingMessage, response: ServerResponse, ctx: Context<InstanceType<Needs>>, signal: AbortSignal) => PromiseLike<unknown>`
  - Test fixture `it` with a `serve` fixture: `serve(handler?) => Promise<{ app, origin }>`

- [ ] **Step 0: Add the two dev dependencies this task starts using**

In `packages/start-http/package.json`, add to `devDependencies` (keeping the keys sorted):

```json
    "@btravstack/di": "catalog:",
    "@btravstack/start": "workspace:*",
```

Then `pnpm install`. Task 1 left them out on purpose — `knip` fails on a devDependency nothing imports, and from this task onward both are imported.

- [ ] **Step 1: Write `packages/start-http/src/test-fixtures.ts`**

```ts
import assert from "node:assert/strict";

import { Module, Port, Provider, type Context } from "@btravstack/di";
import { start, type RunningApp } from "@btravstack/start";
import { expect, test } from "vitest";

import {
  httpRuntime,
  type HttpHandler,
  type HttpInfo,
} from "./http-runtime.js";

/** A port so the runtime's `needs` are non-empty, which is what makes the gate mean something. */
export class Greeting extends Port("Greeting")<{ readonly text: string }> {}

const AppModule = Module("App")({
  provides: [Provider(Greeting)({ value: { text: "hello" } })],
  exports: [Greeting],
});

type App = RunningApp<never, HttpInfo>;

const noop: HttpHandler<typeof Greeting> = (
  _request,
  response,
  _ctx,
  _signal,
) => new Promise<void>((done) => response.end("ok", () => done()));

export type HttpFixtures = {
  /**
   * Starts an app on an ephemeral port and registers its shutdown. Teardown runs
   * on every exit path, including a failing assertion, and keeps the assertion a
   * `finally` used to carry: the app exited `Ok`.
   */
  readonly serve: (
    handler?: HttpHandler<typeof Greeting>,
  ) => Promise<{ readonly app: App; readonly origin: string }>;
};

export const it = test.extend<HttpFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  serve: async ({}, use) => {
    const started: App[] = [];

    await use(async (handler = noop) => {
      const app = start(AppModule, {
        runtime: httpRuntime({
          port: 0,
          hostname: "127.0.0.1",
          needs: [Greeting],
          handler,
        }),
        signals: false,
        probes: false,
        preDrainDelayMs: 0,
        onEvent: () => {},
      });
      started.push(app);

      const info = (await app.runtimeInfo()).get();
      assert.ok(info !== undefined, "the runtime published no Serving.info");
      return { app, origin: `http://127.0.0.1:${info.port}` };
    });

    for (const app of started) {
      app.stop();
      await expect(app.exited).toBeOk();
    }
  },
});
```

- [ ] **Step 2: Write the failing test in `packages/start-http/src/http-runtime.spec.ts`**

```ts
import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("httpRuntime", () => {
  it("publishes the port it actually bound", async ({ serve }) => {
    // GIVEN a runtime asked for an ephemeral port
    const { app } = await serve();

    // WHEN the kernel is asked what the runtime published about itself
    const info = app.runtimeInfo();

    // THEN it is the real port, which is the entire reason `port: 0` is usable
    await expect(info).toBeOkWith({ port: expect.any(Number) });
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd packages/start-http && pnpm vitest run src/http-runtime.spec.ts`
Expected: FAIL — `./http-runtime.js` does not exist.

- [ ] **Step 4: Write `packages/start-http/src/http-runtime.ts`**

```ts
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";

import type { AnyPort, Context } from "@btravstack/di";
import {
  RuntimeStartFailed,
  type Runtime,
  type RuntimeHost,
  type Serving,
} from "@btravstack/start";
import {
  Err,
  Ok,
  OkAsync,
  fromSafePromise,
  type AsyncResult,
  type Result,
} from "unthrown";

/** What the runtime publishes once it is listening, read back through `RunningApp.runtimeInfo()`. */
export type HttpInfo = { readonly port: number };

/**
 * One request. Everything the client receives must be written from here — the
 * unit stays open until the response completes, so there is no way to be late.
 *
 * Returns `PromiseLike<unknown>` rather than `void`: the package needs to know
 * when the handler is finished so it can answer a request the handler declined,
 * and a `void`-returning handler writing asynchronously would draw a premature
 * `404` over a response still in flight. `unknown` because oRPC's `handle`
 * resolves `{ matched: boolean }`; the value is never the unit's result.
 */
export type HttpHandler<Needs extends AnyPort> = (
  request: IncomingMessage,
  response: ServerResponse,
  ctx: Context<InstanceType<Needs>>,
  signal: AbortSignal,
) => PromiseLike<unknown>;

export type HttpOptions<Needs extends AnyPort> = {
  /** `0` lets the OS pick — read it back from `RunningApp.runtimeInfo()`. */
  readonly port: number;
  /** Default `0.0.0.0`: the deployment target is a pod, not a laptop. */
  readonly hostname?: string;
  readonly needs: readonly Needs[];
  readonly handler: HttpHandler<Needs>;
};

const DEFAULT_HOSTNAME = "0.0.0.0";

export const httpRuntime = <Needs extends AnyPort>(
  options: HttpOptions<Needs>,
): Runtime<Needs, HttpInfo> => ({
  name: "http",
  needs: options.needs,
  start: (host: RuntimeHost<Needs>) => listen(host, options),
});

const listen = <Needs extends AnyPort>(
  host: RuntimeHost<Needs>,
  options: HttpOptions<Needs>,
): AsyncResult<Serving<HttpInfo>, RuntimeStartFailed> =>
  fromSafePromise(
    new Promise<Result<Serving<HttpInfo>, RuntimeStartFailed>>((resolve) => {
      // `close()` waits for every connection to end, and a keep-alive client
      // holds one open long after its response. Tracking sockets is what lets
      // `stop` destroy them instead of hanging.
      const sockets = new Set<Socket>();

      const server: Server = createServer((_request, response) => {
        void host;
        response.end();
      });

      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });

      const closed = new Promise<void>((done) => {
        server.once("close", () => done());
      });

      const stopAccepting = (): void => {
        if (!server.listening) return;
        server.close();
        server.closeIdleConnections();
      };

      const onBindError = (cause: unknown): void => {
        resolve(Err(new RuntimeStartFailed({ runtime: "http", cause })));
      };

      server.once("error", onBindError);

      server.listen(options.port, options.hostname ?? DEFAULT_HOSTNAME, () => {
        server.removeListener("error", onBindError);

        const address = server.address();
        const port =
          typeof address === "object" && address !== null
            ? address.port
            : options.port;

        resolve(
          Ok({
            info: { port },
            drain: (signal) => {
              void signal;
              stopAccepting();
              return OkAsync();
            },
            stop: () => {
              stopAccepting();
              for (const socket of sockets) socket.destroy();
              sockets.clear();
              return fromSafePromise(closed);
            },
          }),
        );
      });
    }),
  ).flatMap((result) => result);
```

- [ ] **Step 5: Replace `packages/start-http/src/index.ts`**

```ts
export { httpRuntime } from "./http-runtime.js";
export type { HttpHandler, HttpInfo, HttpOptions } from "./http-runtime.js";
```

- [ ] **Step 6: Run the test and watch it pass**

Run: `cd packages/start-http && pnpm vitest run src/http-runtime.spec.ts`
Expected: PASS, 1 test.

- [ ] **Step 7: Commit**

```bash
git add packages/start-http
git commit -m "feat(start-http): bind a server and publish the bound port"
```

---

### Task 3: A bind failure is a modeled `Err`, never a `Defect`

**Files:**

- Modify: `packages/start-http/src/http-runtime.ts`, `packages/start-http/src/http-runtime.spec.ts`

**Interfaces:**

- Consumes: `httpRuntime` from Task 2
- Produces: no new surface — `start` now yields `Err(RuntimeStartFailed{ runtime: "http" })` for both an occupied port and an out-of-range one

- [ ] **Step 1: Write the two failing tests**

Append inside the existing `describe`:

```ts
it("reports a port it cannot bind", async ({ occupied }) => {
  // GIVEN a port already taken by another listener
  // WHEN a runtime is asked to bind it
  const exited = occupied.appOnTakenPort.exited;

  // THEN the application never starts, and the failure is the kernel's own
  // modeled error rather than an unmodelled defect
  await expect(exited).toBeErrTagged(
    "RuntimeStartFailed",
    expect.objectContaining({ runtime: "http" }),
  );
});

it("reports an out-of-range port as a modeled failure, not a defect", async ({
  appOnPort,
}) => {
  // GIVEN a port node rejects synchronously — `listen` validates the range
  // itself and THROWS `ERR_SOCKET_BAD_PORT` rather than emitting `'error'`
  // WHEN the runtime is asked to bind it
  const exited = appOnPort(70_000).exited;

  // THEN it lands in the declared error channel. A defect here would bypass
  // `AsyncResult<Serving, RuntimeStartFailed>` and exit 70 where a startup
  // failure exits 1.
  await expect(exited).toBeErrTagged(
    "RuntimeStartFailed",
    expect.objectContaining({ runtime: "http" }),
  );
});
```

- [ ] **Step 2: Add the two fixtures to `src/test-fixtures.ts`**

Add to `HttpFixtures`:

```ts
  /** An app started on an explicit port, for the failure paths. Shut down by the fixture. */
  readonly appOnPort: (port: number) => App;
  readonly occupied: { readonly appOnTakenPort: App };
```

Add the implementations inside `test.extend`, and this import at the top:

```ts
import { createServer } from "node:http";
```

```ts
  // oxlint-disable-next-line no-empty-pattern -- see above
  appOnPort: async ({}, use) => {
    const started: App[] = [];

    await use((port) => {
      const app = start(AppModule, {
        runtime: httpRuntime({ port, hostname: "127.0.0.1", needs: [Greeting], handler: noop }),
        signals: false,
        probes: false,
        preDrainDelayMs: 0,
        onEvent: () => {},
      });
      started.push(app);
      return app;
    });

    for (const app of started) app.stop();
  },

  occupied: async ({ appOnPort }, use) => {
    const blocker = createServer();
    const port = await new Promise<number>((done) => {
      blocker.listen(0, "127.0.0.1", () => {
        const address = blocker.address();
        done(typeof address === "object" && address !== null ? address.port : 0);
      });
    });

    await use({ appOnTakenPort: appOnPort(port) });

    blocker.close();
  },
```

- [ ] **Step 3: Run and watch them fail**

Run: `cd packages/start-http && pnpm vitest run src/http-runtime.spec.ts`
Expected: the occupied-port test PASSES already (the `'error'` listener handles it); the out-of-range one FAILS with `Defect([RangeError: options.port should be >= 0 and < 65536 …])`.

If the occupied-port test does not pass, stop — the bind error path is broken and the rest of the plan assumes it works.

- [ ] **Step 4: Wrap `listen` so the synchronous throw is modeled**

In `http-runtime.ts`, wrap the `server.listen(...)` call:

```ts
// `listen` validates the port SYNCHRONOUSLY and throws `ERR_SOCKET_BAD_PORT`
// rather than emitting `'error'` — for a non-integer and for anything outside
// 0..65535 alike. Uncaught, that throw escapes this executor, rejects the
// promise, and reaches the caller as a Defect, bypassing the
// `AsyncResult<Serving, RuntimeStartFailed>` this function declares.
try {
  server.listen(options.port, options.hostname ?? DEFAULT_HOSTNAME, () => {
    // …unchanged body…
  });
} catch (cause) {
  onBindError(cause);
}
```

- [ ] **Step 5: Run and watch both pass**

Run: `cd packages/start-http && pnpm vitest run src/http-runtime.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/start-http
git commit -m "feat(start-http): model a bind failure instead of defecting"
```

---

### Task 4: A bound server keeps an `'error'` listener for life

**Files:**

- Modify: `packages/start-http/src/http-runtime.ts`, `packages/start-http/src/http-runtime.spec.ts`, `packages/start-http/src/test-fixtures.ts`

**Interfaces:**

- Consumes: `httpRuntime` from Task 2
- Produces: no new surface. Adds a `servers` capture to the fixtures: `capturedServers: Server[]`

- [ ] **Step 1: Add the server capture to the top of `src/test-fixtures.ts`**

`vi.mock` is hoisted above the imports by vitest's transform, so it must sit in the fixture module before them. `vi.spyOn` is not an option — patching a node builtin fails with `Cannot redefine property: createServer`.

```ts
import type { Server } from "node:http";

import { vi } from "vitest";

/**
 * Capture the real `http.Server` instances the runtime creates, so the
 * error-listener tests can assert on the server itself without exposing it
 * through the shipped `Serving` type just for a test.
 */
export const capturedServers: Server[] = [];
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      capturedServers.push(server);
      return server;
    },
  };
});
```

- [ ] **Step 2: Write the failing test**

```ts
it("does not throw when the server emits an error after binding", async ({
  serve,
}) => {
  // GIVEN a bound server — `net.Server` still emits `'error'` after listening,
  // on accept failures such as `EMFILE` under fd exhaustion
  await serve();
  const server = capturedServers[capturedServers.length - 1];

  // WHEN one is emitted
  // THEN it is absorbed. Unhandled, it would reach the kernel's
  // `uncaughtException` handler and tear the whole application down over a
  // transient fault in the transport.
  expect(() => server?.emit("error", new Error("accept"))).not.toThrow();
});
```

Import `capturedServers` from `./test-fixtures.js` in the spec.

- [ ] **Step 3: Run and watch it fail**

Run: `cd packages/start-http && pnpm vitest run src/http-runtime.spec.ts -t "after binding"`
Expected: FAIL — `'Error: accept' was thrown`.

- [ ] **Step 4: Swap the bind listener rather than removing it**

In `http-runtime.ts`, beside `onBindError`:

```ts
// Permanent, and deliberately NOT `onBindError`: once the bind has settled
// the deferred, routing a later error there could only resolve an
// already-settled promise. But leaving the server with ZERO `'error'`
// listeners is worse — an unhandled `'error'` throws, and the kernel's
// `uncaughtException` handler turns that into a whole-application teardown
// over a transient accept fault.
const ignoreServingError = (): void => {};
```

and in the listen callback, immediately after `removeListener`:

```ts
server.on("error", ignoreServingError);
```

- [ ] **Step 5: Run and watch it pass**

Run: `cd packages/start-http && pnpm vitest run src/http-runtime.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/start-http
git commit -m "feat(start-http): keep an error listener for the server's whole life"
```

---

### Task 5: One unit per request, closed by the response

**Files:**

- Modify: `packages/start-http/src/http-runtime.ts`, `packages/start-http/src/http-runtime.spec.ts`, `packages/start-http/src/test-fixtures.ts`

**Interfaces:**

- Consumes: `httpRuntime`, `HttpHandler` from Task 2
- Produces: the handler is now invoked per request, with `ctx` and the unit's `AbortSignal`. Adds a `gate` fixture: `{ handler, arrived: Promise<void>, release: () => void }`

- [ ] **Step 1: Add the `gate` fixture to `src/test-fixtures.ts`**

Add to `HttpFixtures`:

```ts
  /** A handler held open until `release()`, so a test can observe a unit in flight. */
  readonly gate: {
    readonly handler: HttpHandler<typeof Greeting>;
    readonly arrived: Promise<void>;
    readonly release: () => void;
  };
```

and the implementation:

```ts
  // oxlint-disable-next-line no-empty-pattern -- see above
  gate: async ({}, use) => {
    let entered!: () => void;
    const arrived = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let open!: () => void;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });

    await use({
      handler: (_request, response, _ctx, _signal) => {
        entered();
        return held.then(() => new Promise<void>((done) => response.end("late", () => done())));
      },
      arrived,
      release: () => open(),
    });

    open();
  },
```

- [ ] **Step 2: Write the failing test**

```ts
it("keeps the unit open until the response is on the wire", async ({
  serve,
  gate,
}) => {
  // GIVEN a request whose handler is held open inside the application
  const { app, origin } = await serve(gate.handler);
  const inFlight = fetch(origin);
  await gate.arrived;

  // WHEN the drain begins while it is still unanswered, and the handler is
  // released only once the phase has moved. `vi.waitUntil` synchronises rather
  // than asserts — the drain samples `inFlightAtStart` in the same synchronous
  // turn that advances the phase.
  app.requestDrain();
  await vi.waitUntil(() => app.phase() === "draining");
  gate.release();
  await inFlight;

  // THEN the kernel counted it as one unit that COMPLETED. Closing the unit on
  // the handler's promise instead would let a response still being written
  // race `Serving.stop` tearing the socket down.
  await expect(app.exited).toBeOkWith(
    expect.objectContaining({
      drain: { inFlightAtStart: 1, completed: 1, abandoned: 0 },
    }),
  );
});
```

Import `vi` from `vitest` in the spec.

Note the `serve` fixture stops each app in teardown; `app.requestDrain()` here settles `exited` first, and `stop()` on an already-exited app is a no-op the kernel's deferred absorbs.

- [ ] **Step 3: Run and watch it fail**

Run: `cd packages/start-http && pnpm vitest run src/http-runtime.spec.ts -t "on the wire"`
Expected: FAIL — the drain reports `inFlightAtStart: 0`, because no unit is created yet.

- [ ] **Step 4: Create a unit per request**

Replace the `createServer` callback in `http-runtime.ts`:

```ts
const server: Server = createServer((request, response) => {
  // The unit's `Result` is FOLDED to a value here rather than dropped:
  // `AsyncResult<T, never>` has an empty *error* channel, but a `Defect`
  // can still be present.
  void host
    .run(metaFor(request), (ctx, signal) => {
      void answer(options.handler(request, response, ctx, signal));
      // The unit's lifetime IS the response's. This is what makes the
      // kernel's "flush inside the unit" contract structural rather than
      // documented: there is no way to write late, because the unit is
      // still open until the bytes are out.
      return closedOf(response);
    })
    .match({
      ok: () => {},
      errCases: (matcher) => matcher,
      // Reached only if the response machinery itself failed, which leaves
      // nothing left to write. Killing the socket is the one remaining
      // courtesy: a client that would otherwise hang gets a reset.
      defect: (cause) => {
        response.destroy(cause instanceof Error ? cause : undefined);
      },
    });
});
```

Add the two helpers and the meta below `listen`, plus `randomUUID` and the `UnitMeta` type import:

```ts
import { randomUUID } from "node:crypto";
import type { UnitMeta } from "@btravstack/start";

const closedOf = (response: ServerResponse): AsyncResult<void, never> =>
  fromSafePromise(
    new Promise<void>((done) => response.once("close", () => done())),
  );

/**
 * `UnitMeta.traceId` defaults to `id`, so `id` is minted fresh per request and
 * never taken from the route: a category there would give every request the same
 * trace id and silently defeat the ambient record. An inbound `x-request-id`
 * becomes the trace id.
 */
const metaFor = (request: IncomingMessage): UnitMeta => {
  const inbound = request.headers["x-request-id"];
  return {
    kind: "http",
    id: randomUUID(),
    ...(typeof inbound === "string" ? { traceId: inbound } : {}),
  };
};
```

Task 7 hardens `metaFor` against a blank header, driven by its own failing test. **Do not add that guard here** — it would leave Task 7 with nothing to fail.

For this task `answer` only keeps a rejecting handler from becoming an unhandled rejection; Task 6 gives it the response and the fallback:

```ts
const answer = async (handled: PromiseLike<unknown>): Promise<void> => {
  try {
    await handled;
  } catch {
    // Task 6 turns this into the 500 the client is owed.
  }
};
```

- [ ] **Step 5: Run and watch it pass**

Run: `cd packages/start-http && pnpm vitest run src/http-runtime.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/start-http
git commit -m "feat(start-http): open one unit per request, closed by the response"
```

---

### Task 6: The package always answers — 404 declined, 500 failed

**Files:**

- Modify: `packages/start-http/src/http-runtime.ts`, `packages/start-http/src/http-runtime.spec.ts`

**Interfaces:**

- Consumes: `answer` from Task 5
- Produces: no new surface. The package's guarantee becomes: every request produces exactly one completed response.

- [ ] **Step 1: Write the two failing tests**

```ts
it("answers 404 when the handler declines to respond", async ({ serve }) => {
  // GIVEN a handler that resolves without writing — oRPC's `matched: false`
  // path, which is how a router says "not mine"
  const { origin } = await serve(() => Promise.resolve({ matched: false }));

  // WHEN a request arrives
  const response = await fetch(origin);

  // THEN the client is answered rather than left hanging until the drain
  // deadline, and the unit closes with it
  expect(response.status).toBe(404);
});

it("answers 500 when the handler fails", async ({ serve }) => {
  // GIVEN a handler whose promise rejects
  const { origin } = await serve(() => Promise.reject(new Error("boom")));

  // WHEN a request arrives
  const response = await fetch(origin);

  // THEN a failure cannot strand a unit either
  expect(response.status).toBe(500);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd packages/start-http && pnpm vitest run src/http-runtime.spec.ts -t "answers"`
Expected: both hang and fail on the 5s test timeout — nothing ends the response, which is precisely the defect.

- [ ] **Step 3: Give `answer` the response and the fallback**

`answer` gains its second parameter here, where there is finally something to do with it. Update the call site in the `createServer` callback too:

```ts
void answer(options.handler(request, response, ctx, signal), response);
```

```ts
/**
 * The package's guarantee: every request produces exactly one completed
 * response. A handler that declines (resolves without writing) gets a `404`; one
 * that fails gets a `500`. Without this the response never ends, the client
 * hangs, and the unit stays counted in flight until the drain deadline.
 *
 * An `AsyncResult` carrying an `Err` or a `Defect` RESOLVES rather than rejects,
 * so it lands in the `404` branch. That is correct: this package does not map
 * `Result` → status, and a handler that hands one back has not answered.
 */
const answer = async (
  handled: PromiseLike<unknown>,
  response: ServerResponse,
): Promise<void> => {
  try {
    await handled;
    end(response, 404, "NotFound");
  } catch {
    end(response, 500, "InternalError");
  }
};

// Silent when the handler has already started writing: there is no status left
// to set, and the response is the handler's to finish.
const end = (response: ServerResponse, status: number, error: string): void => {
  if (response.headersSent || response.writableEnded || response.destroyed)
    return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error }));
};
```

- [ ] **Step 4: Run and watch them pass**

Run: `cd packages/start-http && pnpm vitest run src/http-runtime.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/start-http
git commit -m "feat(start-http): always answer, so a request cannot strand a unit"
```

---

### Task 7: The trace id a caller may choose, and the one it may not

**Files:**

- Modify: `packages/start-http/src/http-runtime.spec.ts`, `packages/start-http/src/test-fixtures.ts`

**Interfaces:**

- Consumes: `metaFor` behaviour from Task 5 (already implemented)
- Produces: a `traced` fixture exposing the `UnitRecord` seen inside the unit

Task 5 left `metaFor` taking `x-request-id` verbatim. The first test below therefore passes immediately — it pins behaviour that already exists, which is fine because it is the half Task 5 deliberately built. **The second must FAIL**, and hardening `metaFor` is this task's implementation step.

- [ ] **Step 1: Add the `traced` fixture to `src/test-fixtures.ts`**

Add `currentUnit` to the `@btravstack/start` import, then:

```ts
  /** A handler that records the ambient record the kernel opened for its unit. */
  readonly traced: {
    readonly handler: HttpHandler<typeof Greeting>;
    readonly seen: () => readonly (string | undefined)[];
  };
```

```ts
  // oxlint-disable-next-line no-empty-pattern -- see above
  traced: async ({}, use) => {
    const seen: (string | undefined)[] = [];
    await use({
      handler: (_request, response, _ctx, _signal) => {
        seen.push(currentUnit()?.traceId);
        return new Promise<void>((done) => response.end("ok", () => done()));
      },
      seen: () => seen,
    });
  },
```

- [ ] **Step 2: Write both tests**

```ts
it("adopts a non-blank x-request-id as the trace id", async ({
  serve,
  traced,
}) => {
  // GIVEN a caller that supplies a correlation id
  const { origin } = await serve(traced.handler);

  // WHEN it makes a request
  await fetch(origin, { headers: { "x-request-id": " abc-123 " } });

  // THEN the id crossed the process boundary, trimmed, so a line logged here
  // joins a trace that started elsewhere
  expect(traced.seen()).toEqual(["abc-123"]);
});

it("keeps its own minted trace id when x-request-id is blank", async ({
  serve,
  traced,
}) => {
  // GIVEN a caller that sends the header but leaves it empty
  const { origin } = await serve(traced.handler);

  // WHEN it makes a request
  await fetch(origin, { headers: { "x-request-id": "" } });

  // THEN the minted id wins. `traceId` falls back to `meta.id` only when
  // nullish, and `""` is not — so a blank header would hand every request from
  // that caller the same empty id, defeating the ambient record exactly as a
  // route template would.
  expect(traced.seen()).toEqual([expect.not.stringMatching(/^$/u)]);
});
```

- [ ] **Step 3: Run and watch the blank-header test fail**

Run: `cd packages/start-http && pnpm vitest run src/http-runtime.spec.ts -t "x-request-id"`
Expected: the non-blank test PASSES; the blank one FAILS, because `""` is not nullish so it wins over the minted id.

- [ ] **Step 4: Harden `metaFor`**

```ts
/**
 * …existing doc comment, plus:
 *
 * Only a NON-BLANK header is adopted: the kernel falls back to `meta.id` when
 * `traceId` is nullish, and `""` is not, so an empty header would win and hand
 * a caller's every request the same blank id — defeating the ambient record
 * exactly as a route template would.
 */
const metaFor = (request: IncomingMessage): UnitMeta => {
  const inbound = request.headers["x-request-id"];
  const traceId = typeof inbound === "string" ? inbound.trim() : "";
  return {
    kind: "http",
    id: randomUUID(),
    ...(traceId === "" ? {} : { traceId }),
  };
};
```

- [ ] **Step 5: Run and watch both pass**

Run: `cd packages/start-http && pnpm vitest run src/http-runtime.spec.ts`
Expected: PASS, 9 tests.

> `fetch` will not send a header with an empty value in every runtime. If the blank-header test cannot make node's `fetch` emit `x-request-id:`, replace it with a raw socket using the `keepAlive` fixture from Task 8 and reorder the two tasks.

- [ ] **Step 6: Commit**

```bash
git add packages/start-http
git commit -m "feat(start-http): ignore a blank x-request-id"
```

---

### Task 8: A drain that actually stops accepting

**Files:**

- Modify: `packages/start-http/src/http-runtime.ts`, `packages/start-http/src/http-runtime.spec.ts`, `packages/start-http/src/test-fixtures.ts`

**Interfaces:**

- Consumes: `httpRuntime` from Task 2, `gate` from Task 5
- Produces: a `keepAlive` fixture — `{ call(origin, headers?) => { head() }, stoppedAccepting(origin), closeAll() }`

- [ ] **Step 1: Add the `keepAlive` fixture to `src/test-fixtures.ts`**

Add `import { once } from "node:events";` and `import { connect, type Socket } from "node:net";`.

```ts
  /**
   * A raw keep-alive connection held BUSY across a drain. `fetch` cannot express
   * it: undici owns its pool, and `Connection` is hop-by-hop so it never reaches
   * the `Response`. Busy is the point — `closeIdleConnections()` reaches every
   * *idle* connection and no others.
   */
  readonly keepAlive: {
    readonly call: (origin: string) => Promise<{ readonly head: () => Promise<string> }>;
    readonly stoppedAccepting: (origin: string) => Promise<void>;
  };
```

```ts
  keepAlive: async ({}, use) => {
    const opened: Socket[] = [];
    const portOf = (origin: string): number => Number(new URL(origin).port);

    await use({
      call: async (origin) => {
        const socket = connect(portOf(origin), "127.0.0.1");
        // A raw socket with no `'error'` listener throws on reset, and the drain
        // under test resets it by design.
        socket.on("error", () => {});
        opened.push(socket);
        await once(socket, "connect");

        let received = "";
        const head = new Promise<string>((resolve) => {
          socket.on("data", (chunk: Buffer) => {
            received += chunk.toString("utf8");
            const end = received.indexOf("\r\n\r\n");
            if (end !== -1) resolve(received.slice(0, end));
          });
        });

        socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n");
        return { head: () => head };
      },
      // A fresh connection being refused is the only honest observable: the phase
      // moves to `"draining"` a tick before `stopAccepting` runs.
      stoppedAccepting: async (origin) => {
        const port = portOf(origin);
        await vi.waitUntil(async () => {
          const probe = connect(port, "127.0.0.1");
          const refused = await new Promise<boolean>((resolve) => {
            probe.once("connect", () => resolve(false));
            probe.once("error", () => resolve(true));
          });
          probe.destroy();
          return refused;
        });
      },
    });

    for (const socket of opened) socket.destroy();
  },
```

- [ ] **Step 2: Write the failing test**

```ts
it("closes a keep-alive connection that was busy when the drain began", async ({
  serve,
  gate,
  keepAlive,
}) => {
  // GIVEN a keep-alive connection whose request is held open, so
  // `closeIdleConnections()` cannot reach it
  const { app, origin } = await serve(gate.handler);
  const held = await keepAlive.call(origin);
  await gate.arrived;

  // WHEN the drain has genuinely stopped accepting, and the request then
  // completes on that still-open connection
  app.requestDrain();
  await keepAlive.stoppedAccepting(origin);
  gate.release();

  // THEN the response tells the client the connection is finished. Left
  // `keep-alive`, node serves further requests down it for the whole drain
  // window — new units the drain exists to stop admitting, and ones the
  // deadline then reports abandoned.
  await expect(held.head()).resolves.toContain("Connection: close");
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `cd packages/start-http && pnpm vitest run src/http-runtime.spec.ts -t "busy when the drain"`
Expected: FAIL — the head contains `Connection: keep-alive` and `Keep-Alive: timeout=5`.

- [ ] **Step 4: Retire open responses when the drain starts**

Add to the `listen` executor, above `createServer`:

```ts
// Responses still open, so the drain can retire them.
// `closeIdleConnections()` reaches every connection IDLE at that instant
// and no others — one with a request in flight survives it, and node
// happily serves further requests down that one for the whole drain
// window. `Connection: close` is what actually retires the socket: node
// closes it once the response ends.
const open = new Set<ServerResponse>();
let draining = false;

const retire = (response: ServerResponse): void => {
  if (!response.headersSent) {
    response.setHeader("Connection", "close");
    return;
  }
  // Headers already on the wire: no header left to change, so the socket
  // is ended once the response is out. Keeps the guarantee "no reuse"
  // rather than "no reuse where we caught the header in time".
  const { socket } = response;
  response.once("finish", () => void socket?.end());
};
```

At the top of the `createServer` callback:

```ts
open.add(response);
response.once("close", () => open.delete(response));
if (draining) retire(response);
```

And in `stopAccepting`, before the `listening` guard:

```ts
draining = true;
// Marked HERE rather than in the request callback, which ran before the
// drain existed — these are precisely the responses holding a connection
// open past `closeIdleConnections()`.
for (const response of open) retire(response);
```

- [ ] **Step 5: Run and watch it pass**

Run: `cd packages/start-http && pnpm vitest run src/http-runtime.spec.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Turn on the coverage thresholds**

Every path the runtime has is now reachable by a test, so the spec's enforced coverage goes on here. In `packages/start-http/vitest.config.ts`, add to `coverage`:

```ts
      thresholds: { lines: 100, functions: 100 },
```

- [ ] **Step 7: Run the whole gate for the package**

```bash
cd packages/start-http && pnpm test && pnpm typecheck
cd ../.. && pnpm lint && pnpm format --check && pnpm knip
```

Expected: all pass, coverage 100% lines/functions. If a line is uncovered, add the missing test rather than lowering the threshold.

- [ ] **Step 8: Commit**

```bash
git add packages/start-http
git commit -m "feat(start-http): retire busy keep-alive connections on drain"
```

---

### Task 9: The package README

**Files:**

- Create: `packages/start-http/README.md`

**Interfaces:**

- Consumes: the full surface from Tasks 2–8
- Produces: documentation only

- [ ] **Step 1: Write `packages/start-http/README.md`**

It must contain, in this order:

1. **Title and one-line claim** — "The HTTP runtime for `@btravstack/start`: one unit per request, and a drain that actually stops accepting."
2. **Install** — `pnpm add @btravstack/start-http @btravstack/start @btravstack/di unthrown`, noting all three are peers and `Node >=20`.
3. **A worked example** — the oRPC snippet from the spec's _Migrating `examples/order-api`_ section, and the Hono one:

```ts
import { getRequestListener } from "@hono/node-server";

start(AppModule, {
  runtime: httpRuntime({
    port: 3000,
    needs: [PlaceOrder],
    handler: getRequestListener(app.fetch),
  }),
});
```

4. **The guarantee**, stated as its own section: _every request produces exactly one completed response, and its unit stays open until that response is on the wire_ — with the reason (a unit that closes early races `Serving.stop` tearing the transport down; measured with an 8 MB body: `UND_ERR_SOCKET: other side closed`).
5. **What it does not do** — routing, middleware, `Result` → status, HTTPS, HTTP/2. One sentence each on why.
6. **Options table** — `port`, `hostname` (default `0.0.0.0`, and why), `needs`, `handler`.
7. **Status codes the package itself writes** — `404` handler declined, `500` handler failed; and that an `AsyncResult` carrying an `Err` resolves, so it reaches `404`.
8. **Writing a runtime** — the section moved from `examples/order-api`, covering the two contracts a runtime owes (flush inside the unit; `UnitMeta.id` unique unless `traceId` is supplied) and noting this package discharges both on the caller's behalf.

- [ ] **Step 2: Verify formatting**

```bash
pnpm format && pnpm format --check
```

- [ ] **Step 3: Commit**

```bash
git add packages/start-http/README.md
git commit -m "docs(start-http): document the package and its guarantee"
```

---

### Task 10: Migrate `examples/order-api`

**Files:**

- Delete: `examples/order-api/src/orpc-runtime.ts`
- Modify: `examples/order-api/package.json`, `examples/order-api/src/main.ts`, `examples/order-api/src/test-fixtures.ts`, `examples/order-api/src/orpc-runtime.spec.ts` (rename to `api.spec.ts`), `examples/order-api/src/needs-gate.test-d.ts` (verify only), `examples/order-api/README.md`

**Interfaces:**

- Consumes: `httpRuntime`, `HttpInfo` from the package
- Produces: `examples/order-api` no longer exports `orpcRuntime` or `OrderApiInfo`

- [ ] **Step 1: Add the dependency**

In `examples/order-api/package.json`, add to `dependencies`:

```json
    "@btravstack/start-http": "workspace:*",
```

Then `pnpm install`.

- [ ] **Step 2: Move the surviving pieces out of `orpc-runtime.ts`**

`dispatch`'s body — the `Module.forkScope(ctx, RequestModule, …)` wrapper around `handler.handle` — becomes the example's handler. Create `examples/order-api/src/handler.ts`:

```ts
import { Module, type Context } from "@btravstack/di";
import {
  FindOrder,
  Logger,
  PlaceOrder,
} from "@btravstack/start-example-order-application";
import { RPCHandler } from "@orpc/server/node";
import type { IncomingMessage, ServerResponse } from "node:http";

import { RequestModule } from "./request-scope.js";
import { orderRouter, type ApiContext } from "./router.js";

export type ApiNeeds = typeof PlaceOrder | typeof FindOrder | typeof Logger;

export const PREFIX = "/rpc" as const;

const handler = new RPCHandler(orderRouter);

/**
 * The application scope belongs to the kernel and holds the database; this
 * layers a per-request scope over it, so a request-scoped provider is torn down
 * with the request and the parent's services are seeded, not rebuilt.
 *
 * The response is flushed inside this callback because `@btravstack/start-http`
 * keeps the unit open until the response completes — the obligation the kernel
 * cannot check is discharged by the package, not by this code being careful.
 */
export const apiHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  ctx: Context<InstanceType<ApiNeeds>>,
): Promise<unknown> =>
  Module.forkScope(ctx, RequestModule, (scope) =>
    handler.handle(request, response, {
      prefix: PREFIX,
      context: { scope } satisfies ApiContext,
    }),
  );
```

If `Module.forkScope` returns an `AsyncResult` rather than a promise, keep it — `PromiseLike<unknown>` accepts it. Adjust the return type to match what `forkScope` actually gives; do not cast.

- [ ] **Step 3: Delete `orpc-runtime.ts` and rewire `main.ts`**

```bash
git rm examples/order-api/src/orpc-runtime.ts
```

In `main.ts`, replace the `orpcRuntime({ port: env.PORT })` runtime with:

```ts
      runtime: httpRuntime({
        port: env.PORT,
        needs: [PlaceOrder, FindOrder, Logger],
        handler: apiHandler,
      }),
```

- [ ] **Step 4: Update the fixtures and specs**

In `examples/order-api/src/test-fixtures.ts`:

- Replace the `orpcRuntime` import with `httpRuntime` from `@btravstack/start-http` and `apiHandler`/`ApiNeeds` from `./handler.js`.
- `App<E>` becomes `RunningApp<E, HttpInfo>`.
- **Delete the `keepAlive` fixture** — its tests moved to the package in Task 8.
- `portOf` still reads `runtimeInfo()`, but `info` is now `{ port }` with no `prefix`.

Rename `orpc-runtime.spec.ts` to `api.spec.ts` (`git mv`) and:

- **Delete** the two tests that moved to the package: _"closes a keep-alive connection that was busy when the drain began"_ and _"keeps its own minted trace id when x-request-id arrives empty"_.
- Update _"publishes … on Serving.info"_ to assert `{ port: expect.any(Number) }` only.
- Keep everything else — the oRPC mapping tests, the trace-id-per-request test, the drain-report tests.

- [ ] **Step 5: Verify the needs gate still holds**

`examples/order-api/src/needs-gate.test-d.ts` must compile **unchanged**. This is the stated reason `examples/` exists.

Run: `cd examples/order-api && pnpm test:types`
Expected: PASS. If it fails, `httpRuntime`'s `Needs` inference is wrong — fix the package's generics, not the test.

- [ ] **Step 6: Run the example's suite and the gate**

```bash
cd examples/order-api && pnpm vitest run && pnpm typecheck
cd ../.. && pnpm lint && pnpm format --check && pnpm knip && pnpm typecheck
```

Expected: all pass. `knip` will flag anything left over from the deleted runtime.

- [ ] **Step 7: Update `examples/order-api/README.md`**

- Replace _The runtime's three methods_ with a short section saying the transport is now `@btravstack/start-http`, linking to it.
- Delete the `Serving.info, not an onListening hook` claim about `{ port, prefix }`; `prefix` is now the example's own constant.
- Keep _One unit per call_, _A request scope over the application scope_ and _The client half_.
- Update the spec count in _Running it_ to whatever `pnpm vitest run` now reports.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(examples): serve order-api through @btravstack/start-http"
```

---

### Task 11: Documentation, changeset, and the full gate

**Files:**

- Modify: `CLAUDE.md`, `README.md`, `examples/README.md`
- Create: `.changeset/start-http.md`

**Interfaces:**

- Consumes: everything
- Produces: a releasable package

- [ ] **Step 1: Update `CLAUDE.md`**

- In **Status → Deferred, deliberately**, strike `@btravstack/start-http` from the first bullet, leaving `-amqp` and `-temporal`. Do not delete the bullet.
- Add `@btravstack/start-http` to the **Shipped** paragraph, described as what was built — _lifecycle only: bind, one unit per request, a drain that retires busy keep-alive connections, stop_ — **not** as "routing, middleware, `Result` → HTTP status", which is what the deferred entry used to promise and is now explicitly out of scope.
- In **What this is**, note that `packages/` now holds two published packages, not one.
- Add a bullet to **Toolchain & conventions** recording that `examples/order-api` consumes `-http` rather than hand-rolling a transport.

- [ ] **Step 2: Update the root `README.md`**

In the deferred-packages table, remove the `@btravstack/start-http` row and add a sentence pointing at the shipped package. Update the sentence under it: "Until one lands, a runtime is roughly forty lines" is now false for HTTP.

- [ ] **Step 3: Update `examples/README.md`**

The _Info_ teaching point currently reads "no two of the three shapes share a field", using `{ port, prefix }`. `order-api` now publishes `{ port }` from the package. Rewrite that sentence so it stays true.

- [ ] **Step 4: Write `.changeset/start-http.md`**

```markdown
---
"@btravstack/start-http": minor
---

The HTTP runtime for `@btravstack/start`.

`httpRuntime({ port, needs, handler })` owns an HTTP server's lifecycle and
nothing else: it binds (publishing the real port on `Serving.info`, so
`port: 0` is usable), opens one kernel unit per request, drains by genuinely
refusing new work, and stops by destroying what is left.

Its guarantee is that every request produces exactly one completed response,
and the unit stays open until that response is on the wire — which makes the
kernel's least-checkable contract structural rather than documented. Routing,
middleware and `Result` → HTTP status are deliberately not included: bring
oRPC, Hono, or a bare function.
```

- [ ] **Step 5: Run the entire gate**

```bash
pnpm format --check && pnpm lint && pnpm typecheck && pnpm knip && pnpm test && pnpm build
```

Expected: all six green, except the documented `binds 9000` failure on a machine where a proxy holds port 9000.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: record @btravstack/start-http as shipped"
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: public surface → 2; compatibility → 10 (oRPC) and 9 (Hono, documented); lifecycle → 2, 5, 8; error handling → 3, 4, 6; testing → 2–8; package layout → 1, 9; the `order-api` migration and both of its named consequences → 10; documentation → 11; out-of-scope items → asserted by omission and stated in 9 and 11.

**Known risks, and what to do about them.**

1. **Task 7's blank-header test depends on `fetch` sending an empty header.** Node's `fetch` may drop it. The task carries the fallback inline: use the raw-socket fixture from Task 8 and swap the order of the two tasks.
2. **`Module.forkScope`'s return type** in Task 10 may be an `AsyncResult` rather than a promise. Both satisfy `PromiseLike<unknown>`; the step says to match what it actually returns rather than cast.
3. **`peerDependencies: { "@btravstack/start": "workspace:^" }`** relies on pnpm rewriting it at publish. If `pnpm install` rejects it under `strictPeerDependencies`, fall back to `"^0.1.0"` and add a note in the changeset that the two version together.
4. **100% coverage on `http-runtime.ts` is a real constraint.** The `typeof address === "object"` fallback and `retire`'s `headersSent` branch are the two lines most likely to end up uncovered — the second is the one this repo already accepted as unreachable in `examples/order-api`. If it cannot be covered, exclude nothing; instead record it in `CLAUDE.md`'s deferred list as the example's twin already is.
