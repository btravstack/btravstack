# `@btravstack/start-temporal` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@btravstack/start-temporal`, a `Runtime` that runs a Temporal worker under the `@btravstack/start` kernel — one unit per activity attempt, and a drain that honours the kernel's deadline rather than Temporal's.

**Architecture:** A factory owns `Worker.create` and adapts it to `Serving`. Activities arrive already final: `asActivities(host, impls)` wraps plain implementations for raw `@temporalio/worker` users, and `activityUnits(host)` is an `ActivityMiddleware` for `temporal-contract` users. The factory registers whatever it is given and never wraps — that is how double-wrapping is made impossible rather than detected.

**Tech Stack:** TypeScript (ESM-first, `NodeNext`), `@temporalio/worker` / `@temporalio/activity` / `@temporalio/common` as peers, `@temporalio/testing`'s time-skipping server for the suite, vitest + `@unthrown/vitest`, tsdown, oxlint + oxfmt.

**Spec:** `docs/superpowers/specs/2026-08-12-start-temporal-design.md`

## Global Constraints

- **No runtime dependencies.** Peers: `@temporalio/worker`, `@temporalio/activity`, `@temporalio/common`, `@btravstack/start`, `@btravstack/di`, `unthrown`. `node:` builtins otherwise.
- **`temporal-contract` is a devDependency only, never a peer.** The package must not appear in a consumer's dependency graph because of us. `activityUnits`' middleware type is declared **structurally** in our own source, not imported.
- **`engines: { node: ">=20" }`.** No `Promise.withResolvers` (Node 22+).
- TypeScript `strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`. **Relative imports carry `.js`.**
- oxlint binding: no `interface` (use `type`), no `any` (use `unknown`), every `@unthrown/oxlint` rule including `no-throw`. Exceptions carry a targeted `oxlint-disable-next-line` **with a reason**.
- **No `Result` may be produced and left unexamined.** `AsyncResult<T, never>` has an empty _error_ channel, not an empty defect channel.
- **Comment density: sparse** — except where a comment guards a specific line against a plausible "simplification".
- **All five test conventions bind:** `describe` first after imports with nothing between; helpers are vitest fixtures in `src/test-fixtures.ts` exporting an extended `it`; teardown in the fixture, never `try`/`finally`; `// GIVEN`/`// WHEN`/`// THEN` in every test body; **one deep `expect` per test**, never an assertion that can decline to run.
- **Coverage: 100% lines and functions, enabled in Task 7** — not before. `Serving` forces `drain`/`stop` into existence long before their tests, and thresholds from Task 1 would leave six red commits (the lesson from the `-http` plan, learned the hard way).
- The gate must stay green: `pnpm format --check`, `pnpm lint`, `pnpm typecheck`, `pnpm knip`, `pnpm test`, `pnpm build`.
- Conventional Commits. Publishable, so it needs a changeset.
- **A new commit per task — never `git commit --amend`.** The branch is shared with the coordinating session.

> **Known local failure, not yours:** `packages/start`'s `invariants.spec.ts` → _"binds 9000 when no probe port is given"_ fails on this machine because a proxy holds `127.0.0.1:9000`. It passes in CI. Do not investigate or reproduce it — one line in your report, then move on.

> **This suite needs the network on a cold cache.** `@temporalio/testing` downloads a 64 MB time-skipping server keyed by the SDK version. Task 2 caches it in `<repo>/.cache/temporal-test-server` with `ttl: "365d"`, matching `examples/order-temporal`. A cold cache with no network fails loudly at `createTimeSkipping()`, naming the URL.

---

## File Structure

| File                                                   | Responsibility                                       |
| ------------------------------------------------------ | ---------------------------------------------------- |
| `packages/start-temporal/package.json`                 | Manifest — peers, exports, scripts                   |
| `packages/start-temporal/tsconfig.json`                | Extends the shared base                              |
| `packages/start-temporal/vitest.config.ts`             | `@unthrown/vitest` setup; thresholds added in Task 7 |
| `packages/start-temporal/LICENSE`                      | Copied verbatim from `packages/start/LICENSE`        |
| `packages/start-temporal/src/temporal-runtime.ts`      | Build the Worker, `Serving`, drain race, stop        |
| `packages/start-temporal/src/activity-units.ts`        | `metaFor`, `asActivities`, `activityUnits`           |
| `packages/start-temporal/src/index.ts`                 | Public surface                                       |
| `packages/start-temporal/src/test-workflows.ts`        | Workflows the suite bundles                          |
| `packages/start-temporal/src/test-fixtures.ts`         | Time-skipping env, `serve`, the extended `it`        |
| `packages/start-temporal/src/temporal-runtime.spec.ts` | The suite                                            |
| `packages/start-temporal/README.md`                    | Package docs                                         |

Two source files, not one: `activity-units.ts` is the only part a `temporal-contract` user touches directly and knows nothing about the Worker's lifecycle. `temporal-runtime.ts` should land around 150 lines.

---

### Task 1: Scaffold the package

**Files:** Create `packages/start-temporal/{package.json,tsconfig.json,vitest.config.ts,LICENSE}` and `src/index.ts`

**Interfaces:** Produces a workspace `@btravstack/start-temporal` the root gate discovers via `pnpm-workspace.yaml`'s `packages/*` glob.

Configuration, so no unit test; the gate is its verification.

- [ ] **Step 1: Create `packages/start-temporal/package.json`**

```json
{
  "name": "@btravstack/start-temporal",
  "version": "0.0.0",
  "description": "The Temporal worker runtime for @btravstack/start: one unit per activity attempt, and a drain that honours the kernel's deadline",
  "keywords": [
    "temporal",
    "worker",
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
    "directory": "packages/start-temporal"
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
    "vitest": "catalog:"
  },
  "peerDependencies": {
    "@btravstack/di": "^0.1.0",
    "@btravstack/start": "workspace:^",
    "@temporalio/activity": "^1.22.0",
    "@temporalio/common": "^1.22.0",
    "@temporalio/worker": "^1.22.0",
    "unthrown": "^5.0.0"
  },
  "engines": { "node": ">=20" }
}
```

`devDependencies` deliberately omits everything not yet imported — `pnpm knip` fails the gate on an unused one, which cost the `-http` plan a fix round. Task 2 adds the Temporal and kernel packages when its code imports them.

- [ ] **Step 2: Create `packages/start-temporal/tsconfig.json`**

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

- [ ] **Step 3: Create `packages/start-temporal/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["@unthrown/vitest"],
    // The time-skipping server download dominates a cold run.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.spec.ts",
        "src/test-fixtures.ts",
        "src/test-workflows.ts",
      ],
    },
  },
});
```

Thresholds are **not** set here. Task 7 adds them once every path is reachable.

- [ ] **Step 4: Copy the LICENSE**

```bash
cp packages/start/LICENSE packages/start-temporal/LICENSE
```

Verbatim — same text, same holder, same year. `packages/start-http` shipped without one and had to add it mid-plan.

- [ ] **Step 5: Create a placeholder `packages/start-temporal/src/index.ts`**

```ts
export type TemporalInfo = {
  readonly taskQueue: string;
  readonly namespace: string;
};
```

- [ ] **Step 6: Install and verify**

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm format --check && pnpm knip
```

Expected: all pass. If `knip` reports an unused devDependency, remove it — do not add an ignore.

- [ ] **Step 7: Commit**

```bash
git add packages/start-temporal pnpm-lock.yaml
git commit -m "chore(start-temporal): scaffold the package"
```

---

### Task 2: A worker that runs, under the time-skipping server

**Files:** Create `src/temporal-runtime.ts`, `src/test-workflows.ts`, `src/test-fixtures.ts`, `src/temporal-runtime.spec.ts`; modify `src/index.ts`, `package.json`

**Interfaces produced** — later tasks depend on these exact names:

- `temporalRuntime<Needs extends AnyPort>(options: TemporalOptions<Needs>): Runtime<Needs, TemporalInfo>`
- `TemporalInfo = { readonly taskQueue: string; readonly namespace: string }`
- `TemporalOptions<Needs>` = `{ connection: NativeConnection; taskQueue: string; namespace?: string; workflows: { workflowsPath: string } | { workflowBundle: WorkflowBundleWithSourceMap }; activities: Record<string, (...args: never[]) => unknown>; needs: readonly Needs[]; forceAfter?: Duration; gracePeriod?: Duration }`
- Fixture `it` with `serve(activities?) => Promise<{ app, client, taskQueue }>`

- [ ] **Step 1: Add the dependencies this task imports**

To `devDependencies` (keys sorted), and **only these** — `knip` fails the gate on an unused devDependency and a `knip.json` ignore is not an acceptable answer. `@temporalio/activity` is deliberately absent; Task 4 adds it with `metaFor`, the first code to import it. Add: `"@btravstack/di": "catalog:"`, `"@btravstack/start": "workspace:*"`, `"@temporalio/client": "catalog:"`, `"@temporalio/common": "catalog:"`, `"@temporalio/testing": "catalog:"`, `"@temporalio/worker": "catalog:"`, `"@temporalio/workflow": "catalog:"`, `"unthrown": "catalog:"`. Then `pnpm install`.

If any is missing from the root `pnpm-workspace.yaml` catalog, add it there at the version `examples/order-temporal` already uses — do not introduce a second version of a Temporal package.

- [ ] **Step 2: Create `packages/start-temporal/src/test-workflows.ts`**

```ts
import { proxyActivities } from "@temporalio/workflow";

const { echo } = proxyActivities<{ echo: (value: string) => Promise<string> }>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 1 },
});

/** The suite's only workflow: it exists to make one activity attempt happen. */
export const runEcho = async (value: string): Promise<string> => echo(value);
```

- [ ] **Step 3: Create `packages/start-temporal/src/test-fixtures.ts`**

```ts
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Module, Port, Provider } from "@btravstack/di";
import { start, type RunningApp } from "@btravstack/start";
import { Client } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { expect, test } from "vitest";

import { temporalRuntime, type TemporalInfo } from "./temporal-runtime.js";

/**
 * The time-skipping server binary, cached where we decide rather than in the OS
 * temp directory — which CI wipes between jobs and macOS purges on its own
 * schedule — and with a year-long ttl rather than the SDK's one day.
 */
const downloadDir = fileURLToPath(
  new URL("../../../.cache/temporal-test-server/", import.meta.url),
);
mkdirSync(downloadDir, { recursive: true });

export class Greeting extends Port("Greeting")<{ readonly text: string }> {}

const AppModule = Module("App")({
  provides: [Provider(Greeting)({ value: { text: "hello" } })],
  exports: [Greeting],
});

type App = RunningApp<never, TemporalInfo>;

let queueSeq = 0;
const nextTaskQueue = (): string => `t-${(queueSeq += 1)}-${process.pid}`;

const defaultActivities = { echo: (value: string) => Promise.resolve(value) };

export type TemporalFixtures = {
  readonly serve: (
    activities?: Record<string, (...args: never[]) => unknown>,
  ) => Promise<{
    readonly app: App;
    readonly client: Client;
    readonly taskQueue: string;
  }>;
};

export const it = test.extend<TemporalFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  serve: async ({}, use) => {
    const env = await TestWorkflowEnvironment.createTimeSkipping({
      server: {
        executable: { type: "cached-download", downloadDir, ttl: "365d" },
      },
    });
    const started: App[] = [];

    await use(async (activities = defaultActivities) => {
      const taskQueue = nextTaskQueue();
      const app = start(AppModule, {
        runtime: temporalRuntime({
          connection: env.nativeConnection,
          taskQueue,
          workflows: {
            workflowsPath: fileURLToPath(
              new URL("./test-workflows.ts", import.meta.url),
            ),
          },
          activities,
          needs: [Greeting],
        }),
        signals: false,
        probes: false,
        preDrainDelayMs: 0,
        onEvent: () => {},
      });
      started.push(app);
      await app.runtimeInfo();
      return { app, client: env.client, taskQueue };
    });

    for (const app of started) {
      app.stop();
      await expect(app.exited).toBeOk();
    }
    await env.teardown();
  },
});
```

`workflowsPath` points at the **`.ts` source**. Temporal's bundler `statSync`s the entrypoint with no extension aliasing and then compiles TypeScript through its own swc loader, so a `.js` path that does not exist on disk fails outright and no prebundling step is needed.

- [ ] **Step 4: Write the failing test in `src/temporal-runtime.spec.ts`**

```ts
import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("temporalRuntime", () => {
  it("publishes the task queue and namespace it polls", async ({ serve }) => {
    // GIVEN a worker polling a queue of this test's own
    const { app, taskQueue } = await serve();

    // WHEN the kernel is asked what the runtime published about itself
    const info = app.runtimeInfo();

    // THEN it is the pair that identifies a Temporal worker to an operator
    await expect(info).toBeOkWith({ taskQueue, namespace: "default" });
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `cd packages/start-temporal && pnpm vitest run src/temporal-runtime.spec.ts`
Expected: FAIL — `./temporal-runtime.js` does not exist.

- [ ] **Step 6: Write `packages/start-temporal/src/temporal-runtime.ts`**

```ts
import type { AnyPort } from "@btravstack/di";
import {
  RuntimeStartFailed,
  type Runtime,
  type RuntimeHost,
  type Serving,
} from "@btravstack/start";
import type { Duration } from "@temporalio/common";
import {
  Worker,
  type NativeConnection,
  type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import {
  ErrAsync,
  OkAsync,
  fromPromise,
  fromSafePromise,
  type AsyncResult,
} from "unthrown";

/** What the worker publishes once it is polling, read back through `RunningApp.runtimeInfo()`. */
export type TemporalInfo = {
  readonly taskQueue: string;
  readonly namespace: string;
};

export type TemporalOptions<Needs extends AnyPort> = {
  readonly connection: NativeConnection;
  readonly taskQueue: string;
  readonly namespace?: string;
  readonly workflows:
    | { readonly workflowsPath: string }
    | { readonly workflowBundle: WorkflowBundleWithSourceMap };
  /**
   * Activities as Temporal will see them — already final. Wrap plain
   * implementations with `asActivities`, or use the `activityUnits` middleware
   * with `temporal-contract`. The factory never wraps, which is what makes
   * double-wrapping impossible rather than something to detect.
   */
  readonly activities: Record<string, (...args: never[]) => unknown>;
  readonly needs: readonly Needs[];
  /** Temporal's `shutdownForceTime`. Default `15 seconds`. Keep it at or below the kernel's `drainTimeoutMs`. */
  readonly forceAfter?: Duration;
  /** Temporal's `shutdownGraceTime`. Default `10 seconds`. */
  readonly gracePeriod?: Duration;
};

const DEFAULT_NAMESPACE = "default";
const DEFAULT_GRACE: Duration = "10 seconds";
const DEFAULT_FORCE: Duration = "15 seconds";

export const temporalRuntime = <Needs extends AnyPort>(
  options: TemporalOptions<Needs>,
): Runtime<Needs, TemporalInfo> => ({
  name: "temporal",
  needs: options.needs,
  start: (host: RuntimeHost<Needs>) => createWorker(host, options),
});

const createWorker = <Needs extends AnyPort>(
  host: RuntimeHost<Needs>,
  options: TemporalOptions<Needs>,
): AsyncResult<Serving<TemporalInfo>, RuntimeStartFailed> => {
  void host;
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;

  return fromPromise(
    Worker.create({
      connection: options.connection,
      namespace,
      taskQueue: options.taskQueue,
      ...options.workflows,
      activities: options.activities,
      shutdownGraceTime: options.gracePeriod ?? DEFAULT_GRACE,
      shutdownForceTime: options.forceAfter ?? DEFAULT_FORCE,
    }),
    (cause) => new RuntimeStartFailed({ runtime: "temporal", cause }),
  ).map((worker) => poll(worker, options.taskQueue, namespace));
};

const poll = (
  worker: Worker,
  taskQueue: string,
  namespace: string,
): Serving<TemporalInfo> => {
  // `run()` moves the worker to RUNNING synchronously, before its first await,
  // so the worker is already polling by the time this returns — which is what
  // lets `stopPolling` trust `getState()`.
  //
  // The result is HELD, not dropped: `run()` can defect, and an empty error
  // channel is not an empty defect channel. `drain` and `stop` hand it to the
  // kernel, which is what consumes it.
  const running = fromSafePromise(worker.run());

  // `shutdown()` on a worker that is not RUNNING throws Temporal's
  // `IllegalStateError`, and both methods below can reach it — on the signal
  // path `stop` always runs after `drain` already shut the worker down.
  const stopPolling = (): void => {
    if (worker.getState() === "RUNNING") worker.shutdown();
  };

  return {
    info: { taskQueue, namespace },
    drain: (signal) => {
      void signal;
      stopPolling();
      return OkAsync();
    },
    stop: () => {
      stopPolling();
      return running;
    },
  };
};

void ErrAsync;
```

`drain`'s deadline race lands in Task 6; this task only needs a worker that starts and stops. Remove the `void ErrAsync;` line if the import is unused — do not leave a dead import for `knip` to find.

- [ ] **Step 7: Replace `src/index.ts`**

```ts
export { temporalRuntime } from "./temporal-runtime.js";
export type { TemporalInfo, TemporalOptions } from "./temporal-runtime.js";
```

- [ ] **Step 8: Run the test and watch it pass**

Run: `cd packages/start-temporal && pnpm vitest run src/temporal-runtime.spec.ts`
Expected: PASS, 1 test. First run downloads the test server — allow a minute.

- [ ] **Step 9: Commit**

```bash
git add packages/start-temporal pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "feat(start-temporal): run a worker and publish what it polls"
```

---

### Task 3: A worker that cannot start is a modeled `Err`

**Files:** Modify `src/temporal-runtime.ts`, `src/temporal-runtime.spec.ts`, `src/test-fixtures.ts`

**Interfaces:** Consumes `temporalRuntime`. Adds a `brokenWorkflows` fixture returning a `workflowsPath` that will not bundle.

- [ ] **Step 1: Add the fixture**

To `TemporalFixtures`: `readonly serveBroken: () => Promise<App>;` — same as `serve` but with `workflows: { workflowsPath: fileURLToPath(new URL("./does-not-exist.js", import.meta.url)) }`, returning the app without awaiting `runtimeInfo()`.

- [ ] **Step 2: Write the failing test**

```ts
it("reports a workflow bundle that will not build as a modeled failure", async ({
  serveBroken,
}) => {
  // GIVEN a workflows path that cannot be bundled
  const app = await serveBroken();

  // WHEN the application is started
  // THEN it never comes up, and the failure is the kernel's own modeled error
  // rather than an unmodelled defect — `Worker.create` rejects, and an
  // unqualified `fromSafePromise` would have turned that into a `Defect`.
  await expect(app.exited).toBeErrTagged(
    "RuntimeStartFailed",
    expect.objectContaining({ runtime: "temporal" }),
  );
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `cd packages/start-temporal && pnpm vitest run src/temporal-runtime.spec.ts -t "will not build"`

**Expected: PASS.** Task 2 already wrote `fromPromise(..., qualify)` because the design demanded the declared error channel, so there is no red to watch here and pretending otherwise would be a fabricated TDD cycle. This is a **characterisation test**, and its value is as a regression guard — so prove it can catch the regression instead:

1. Temporarily change `createWorker`'s `fromPromise(Worker.create(...), qualify)` to `fromSafePromise(Worker.create(...))`.
2. Re-run the filtered test. It must now **FAIL**, naming a `Defect` rather than `Err(RuntimeStartFailed)` — that is exactly the regression the test exists to catch, and it is the difference between `runMain` exiting 1 and exiting 70.
3. Restore the original code and confirm it passes again.
4. Record both runs verbatim. If step 2 does not fail, the test is not pinning the error channel — stop and report rather than committing it.

- [ ] **Step 4: Title the test for what it is**

No production change should be needed — Task 2's `fromPromise` is already correct. Name the test so it does not imply a cycle it did not have, and make the `// THEN` comment state what the guard protects: a `Defect` here would bypass the declared `AsyncResult<Serving, RuntimeStartFailed>` and turn a startup failure's exit code from 1 into 70.

- [ ] **Step 5: Run and watch it pass**

Run: `cd packages/start-temporal && pnpm vitest run src/temporal-runtime.spec.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/start-temporal
git commit -m "feat(start-temporal): model a worker that cannot start"
```

---

### Task 4: One unit per activity attempt

**Files:** Create `src/activity-units.ts`; modify `src/index.ts`, `src/test-fixtures.ts`, `src/temporal-runtime.spec.ts`

**Interfaces produced:**

- `asActivities<Needs extends AnyPort>(host: RuntimeHost<Needs>, impls: Record<string, ActivityImpl<Needs>>): Record<string, (...args: never[]) => unknown>`
- `ActivityImpl<Needs>` = `(ctx: Context<InstanceType<Needs>>, signal: AbortSignal, ...args: never[]) => AsyncResult<unknown, unknown> | Promise<unknown> | unknown`
- `metaFor(): UnitMeta` — module-private

- [ ] **Step 0: Add `@temporalio/activity`**

`"@temporalio/activity": "catalog:"` into `devDependencies` (keys sorted), then `pnpm install`. Task 2 deliberately left it out because nothing imported it and `knip` fails on an unused devDependency; `metaFor` below is the first code to import it.

- [ ] **Step 1: Write the failing test**

```ts
it("opens one kernel unit per activity attempt", async ({
  serve,
  recorder,
}) => {
  // GIVEN an activity wrapped for the kernel
  const { client, taskQueue } = await serve(recorder.build);

  // WHEN a workflow drives one attempt
  await client.workflow.execute("runEcho", {
    taskQueue,
    workflowId: "wf-unit-1",
    args: ["x"],
  });

  // THEN the attempt ran inside a unit whose meta identifies it by Temporal's
  // task token, with the workflow id as the correlation id — `id` must be
  // unique per unit, and a workflow id is not: an activity is retried under
  // the same execution.
  expect(recorder.seen()).toEqual([
    { kind: "activity", id: recorder.taskToken(), traceId: "wf-unit-1" },
  ]);
});
```

- [ ] **Step 2: Add the `recorder` fixture to `src/test-fixtures.ts`**

**`currentUnit()` cannot see `UnitMeta.id`.** It returns a `UnitRecord`, whose `unitId` is the kernel's own counter (`u1`, `u2`, …); only `traceId` survives from the meta. So the fixture observes the meta **on its way into the kernel**, through a proxy that records and forwards unchanged. The real unit still opens — nothing is stubbed.

```ts
  /** Records the `UnitMeta` each attempt opens with, and the token it should carry. */
  readonly recorder: {
    readonly build: (host: RuntimeHost<typeof Greeting>) => Record<string, (...args: never[]) => unknown>;
    readonly seen: () => readonly UnitMeta[];
    readonly taskToken: () => string;
  };
```

```ts
  // oxlint-disable-next-line no-empty-pattern -- see above
  recorder: async ({}, use) => {
    const seen: UnitMeta[] = [];
    let token = "";

    await use({
      build: (host) => {
        // Forwards to the real host; the only addition is the capture, so the
        // unit, its ambient record and its accounting are all genuinely the
        // kernel's. Observing `meta` here is the only way to assert it — the
        // ambient record deliberately does not carry it.
        const watched: RuntimeHost<typeof Greeting> = {
          ctx: host.ctx,
          run: (meta, work) => {
            seen.push(meta);
            return host.run(meta, work);
          },
        };
        return asActivities(watched, {
          echo: (_ctx, _signal, value: string) => {
            token = activityInfo().base64TaskToken;
            return Promise.resolve(value);
          },
        });
      },
      seen: () => seen,
      taskToken: () => token,
    });
  },
```

Import `UnitMeta` and `RuntimeHost` from `@btravstack/start`, `activityInfo` from `@temporalio/activity`, and `asActivities` from `./activity-units.js`.

- [ ] **Step 3: Run and watch it fail**

Run: `cd packages/start-temporal && pnpm vitest run src/temporal-runtime.spec.ts -t "one kernel unit"`
Expected: FAIL — `seen()` is `[undefined]`, because nothing opened a unit; the raw activity ran outside one.

- [ ] **Step 4: Write `packages/start-temporal/src/activity-units.ts`**

```ts
import type { AnyPort, Context } from "@btravstack/di";
import type { RuntimeHost, UnitMeta } from "@btravstack/start";
import { activityInfo } from "@temporalio/activity";

export type ActivityImpl<Needs extends AnyPort> = (
  ctx: Context<InstanceType<Needs>>,
  signal: AbortSignal,
  ...args: never[]
) => unknown;

/**
 * `UnitMeta.id` must be unique per unit, and a workflow id is **not** one: an
 * activity is retried under the same execution, and Temporal lets a workflow id
 * be reused once an execution closes. A task token identifies one activity task
 * attempt, so its uniqueness is Temporal's guarantee rather than an argument of
 * ours.
 *
 * The workflow id becomes the `traceId`, which is what `traceId` is for — the
 * correlation id, minted outside this process, holding steady across every
 * retry so all attempts join up in a log. An activity with no workflow falls
 * back to the activity id, itself stable across that activity's attempts.
 */
const metaFor = (): UnitMeta => {
  const info = activityInfo();
  return {
    kind: "activity",
    id: info.base64TaskToken,
    traceId: info.workflowExecution?.workflowId ?? info.activityId,
  };
};

/**
 * Wrap plain implementations so each attempt becomes one kernel unit. The
 * `temporal-contract` path uses `activityUnits` instead; both produce a record
 * the factory registers without wrapping again.
 */
export const asActivities = <Needs extends AnyPort>(
  host: RuntimeHost<Needs>,
  impls: Record<string, ActivityImpl<Needs>>,
): Record<string, (...args: never[]) => unknown> =>
  Object.fromEntries(
    Object.entries(impls).map(([name, impl]) => [
      name,
      (...args: never[]) =>
        host.run(
          metaFor(),
          (ctx, signal) => impl(ctx, signal, ...args) as never,
        ),
    ]),
  );
```

The `as never` is a genuine cast and needs a reason in a comment, or a better signature: `host.run`'s work callback is generic in `T`/`E`, and a heterogeneous record erases them. If you can express this without the cast, do — and say so in your report.

- [ ] **Step 5: Export it and use it in the fixture**

`src/index.ts` gains `export { asActivities } from "./activity-units.js";` and `export type { ActivityImpl } from "./activity-units.js";`. The `recorder` fixture's activities must now be built with `asActivities(host, …)` — but `host` is not available to a fixture. **Resolve this by having `serve` accept a builder:** `serve((host) => asActivities(host, { echo: … }))`. Update `serve`'s signature to `(build?: (host) => Record<string, …>) => …` and pass `options.activities` through from the runtime. If `RuntimeHost` is not reachable at that point, report it — this is the seam the whole task turns on.

- [ ] **Step 6: Run and watch it pass**

Run: `cd packages/start-temporal && pnpm vitest run src/temporal-runtime.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/start-temporal
git commit -m "feat(start-temporal): open one unit per activity attempt"
```

---

### Task 5: An in-flight activity finishes when the drain has time

**Files:** Modify `src/temporal-runtime.spec.ts`, `src/test-fixtures.ts`

**Interfaces:** Consumes `temporalRuntime`, `asActivities`. Adds a `gate` fixture: `{ build, arrived, release }`.

This is kernel invariant #2 proved through a real transport. No production change should be needed — if one is, the drain is wrong.

- [ ] **Step 1: Add the `gate` fixture**

```ts
  readonly gate: {
    readonly build: (host: never) => Record<string, (...args: never[]) => unknown>;
    readonly arrived: Promise<void>;
    readonly release: () => void;
  };
```

Implemented as `asActivities(host, { echo: (_ctx, _signal, value) => { entered(); return held.then(() => value); } })`, with `arrived`/`release` in the same shape `examples/order-api`'s gate uses.

- [ ] **Step 2: Write the test**

```ts
it("lets an in-flight activity finish while draining", async ({
  serve,
  gate,
}) => {
  // GIVEN an activity held open inside the application
  const { app, client, taskQueue } = await serve(gate.build);
  const running = client.workflow.execute("runEcho", {
    taskQueue,
    workflowId: "wf-drain-1",
    args: ["x"],
  });
  await gate.arrived;

  // WHEN the drain starts and the activity is released once the phase moved
  app.requestDrain();
  await vi.waitUntil(() => app.phase() === "draining");
  gate.release();

  // THEN the kernel counted it as one unit that COMPLETED, through a real
  // Workflow-Task / Activity-Task loop
  await running;
  await expect(app.exited).toBeOkWith(
    expect.objectContaining({
      drain: { inFlightAtStart: 1, completed: 1, abandoned: 0 },
    }),
  );
});
```

- [ ] **Step 3: Run it**

Run: `cd packages/start-temporal && pnpm vitest run src/temporal-runtime.spec.ts -t "in-flight activity"`
Expected: **PASS on arrival.** This task characterises behaviour Tasks 2–4 already built; it is the safety net for Task 6, which changes `drain`. If it fails, do not change the test — report, because the drain is wrong before Task 6 has touched it.

- [ ] **Step 4: Commit**

```bash
git add packages/start-temporal
git commit -m "test(start-temporal): pin that a drained activity still completes"
```

---

### Task 6: The kernel's deadline releases a hung activity

**Files:** Modify `src/temporal-runtime.ts`, `src/temporal-runtime.spec.ts`

**Interfaces:** Consumes everything so far. This is the reason the package exists.

- [ ] **Step 1: Write the failing test**

```ts
it("releases the kernel at its own deadline, not Temporal's", async ({
  serve,
  gate,
}) => {
  // GIVEN an activity that never finishes, and a drain with no time to give it
  const { app, client, taskQueue } = await serve(gate.build, {
    drainTimeoutMs: 0,
  });
  void client.workflow.execute("runEcho", {
    taskQueue,
    workflowId: "wf-hung-1",
    args: ["x"],
  });
  await gate.arrived;

  // WHEN the drain runs out of time
  const askedAt = Date.now();
  app.requestDrain();
  const report = await app.exited;

  // THEN the exit is not held hostage by a worker that cannot stop: the
  // activity is reported abandoned and the process is released on the
  // kernel's deadline rather than Temporal's `shutdownForceTime`, which is
  // what `Serving.drain(signal)` promises the kernel.
  expect(
    report.map((exit) => ({
      drain: exit.drain,
      promptly: Date.now() - askedAt < 5_000,
    })),
  ).toBeOkWith({
    drain: { inFlightAtStart: 1, completed: 0, abandoned: 1 },
    promptly: true,
  });
});
```

`serve` needs a second parameter forwarding `drainTimeoutMs` into `start`'s options — add it.

- [ ] **Step 2: Run and watch it fail**

Run: `cd packages/start-temporal && pnpm vitest run src/temporal-runtime.spec.ts -t "own deadline"`
Expected: FAIL by **timing out**, or by `promptly: false` — `stop()` awaits `running`, which cannot settle until Temporal's `shutdownForceTime` (15 s) expires. That is precisely the defect.

- [ ] **Step 3: Race the deadline in `poll`**

```ts
// The kernel's deadline, kept from `drain` so `stop` is released by the same
// abort. Without it the release is only half done: `finish` calls `stop()`
// after the drain has already timed out, and a `stop` that started waiting on
// `running` all over again would put Temporal's `shutdownForceTime` back in
// charge of when the process exits.
let deadline: AbortSignal | undefined;

const stopped = (): AsyncResult<void, never> =>
  deadline === undefined ? running : releasedBy(deadline, running);

return {
  info: { taskQueue, namespace },
  // `@temporalio/worker` has no public forced-shutdown call —
  // `Worker.forceShutdown$` is `protected` and `Runtime.shutdown()` is
  // process-global — so the escalation available to a runtime is to stop
  // waiting: the kernel is handed back its thread at its own deadline, and
  // the worker is left to Temporal's `shutdownForceTime` and to the entry
  // point closing the connection underneath it.
  drain: (signal) => {
    deadline = signal;
    stopPolling();
    return stopped();
  },
  stop: () => {
    stopPolling();
    return stopped();
  },
};
```

with:

```ts
const releasedBy = (
  signal: AbortSignal,
  running: AsyncResult<void, never>,
): AsyncResult<void, never> =>
  fromSafePromise(Promise.race([running, whenAborted(signal)])).flatMap(
    (settled) => settled,
  );

const whenAborted = (signal: AbortSignal): AsyncResult<void, never> =>
  signal.aborted
    ? OkAsync()
    : fromSafePromise(
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      );
```

- [ ] **Step 4: Run and watch both drain tests pass**

Run: `cd packages/start-temporal && pnpm vitest run src/temporal-runtime.spec.ts`
Expected: PASS, 5 tests. Task 5's test must still pass — it is the guard that this change did not break the happy path.

- [ ] **Step 5: Commit**

```bash
git add packages/start-temporal
git commit -m "feat(start-temporal): release the kernel at its own deadline"
```

---

### Task 7: The `temporal-contract` seam, and the coverage gate

**Files:** Modify `src/activity-units.ts`, `src/index.ts`, `src/temporal-runtime.spec.ts`, `src/test-fixtures.ts`, `vitest.config.ts`, `package.json`

**Interfaces produced:**

- `activityUnits<Needs extends AnyPort>(host: RuntimeHost<Needs>): ActivityMiddleware<Needs>`
- `ActivityMiddleware<Needs>` — declared **structurally in our source**, matching `temporal-contract`'s shape: `(invocation: { readonly activityName: string; readonly input: unknown; readonly context: Record<string, unknown> }, next: (patch?: { readonly context?: Record<string, unknown> }) => AsyncResult<unknown, unknown>) => AsyncResult<unknown, unknown>`

- [ ] **Step 1: Add `@temporal-contract/worker` as a devDependency**

`"@temporal-contract/worker": "catalog:"` — **devDependency only**. It must never enter `peerDependencies`; the whole point is that a consumer does not inherit it. Then `pnpm install`.

- [ ] **Step 2: Write the failing test**

```ts
it("opens a unit and injects the context through a contract middleware", async ({
  serve,
  contractSeam,
}) => {
  // GIVEN activities declared through temporal-contract's handler, with this
  // package's middleware in the chain
  const { client, taskQueue } = await serve(contractSeam.build);

  // WHEN a workflow drives one attempt
  await client.workflow.execute("runEcho", {
    taskQueue,
    workflowId: "wf-seam-1",
    args: ["x"],
  });

  // THEN the implementation ran inside a kernel unit and received the
  // application context through temporal-contract's own channel — so a
  // contract user pays nothing extra for the kernel's unit boundary
  expect(contractSeam.seen()).toEqual([
    { traceId: "wf-seam-1", greeting: "hello" },
  ]);
});
```

- [ ] **Step 3: Add the `contractSeam` fixture**

It builds `declareActivitiesHandler({ contract, middleware: [activityUnits(host)], activities: { … } })` over a minimal contract with one `echo` activity, whose implementation reads `currentUnit()?.traceId` and `context.ctx.get(Greeting).text` and pushes both. Define the contract in the fixture module.

- [ ] **Step 4: Run and watch it fail**

Run: `cd packages/start-temporal && pnpm vitest run src/temporal-runtime.spec.ts -t "contract middleware"`
Expected: FAIL — `activityUnits` does not exist.

- [ ] **Step 5: Implement `activityUnits` in `src/activity-units.ts`**

```ts
/**
 * The shape of `temporal-contract`'s `ActivityMiddleware`, declared here rather
 * than imported. Structural typing makes the two compatible, and it keeps
 * `temporal-contract` out of this package's peer range — a consumer who does
 * not use it should never see it in their dependency graph.
 */
export type ActivityMiddleware<Needs extends AnyPort> = (
  invocation: {
    readonly activityName: string;
    readonly input: unknown;
    readonly context: Record<string, unknown>;
  },
  next: (patch?: {
    readonly context?: { readonly ctx: Context<InstanceType<Needs>> };
  }) => AsyncResult<unknown, unknown>,
) => AsyncResult<unknown, unknown>;

/**
 * Open one kernel unit per activity attempt, and hand the application context
 * downstream through `temporal-contract`'s own context channel — which is
 * per-invocation, so a future per-unit `forkScope` lands here without an API
 * change.
 */
export const activityUnits =
  <Needs extends AnyPort>(
    host: RuntimeHost<Needs>,
  ): ActivityMiddleware<Needs> =>
  (_invocation, next) =>
    host.run(metaFor(), (ctx) => next({ context: { ctx } }) as never);
```

- [ ] **Step 6: Run and watch it pass**

Run: `cd packages/start-temporal && pnpm vitest run src/temporal-runtime.spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7: Turn on the coverage thresholds**

Every path is now reachable. In `vitest.config.ts`, add to `coverage`:

```ts
      thresholds: { lines: 100, functions: 100 },
```

- [ ] **Step 8: Run the package gate**

```bash
cd packages/start-temporal && pnpm test && pnpm typecheck
cd ../.. && pnpm lint && pnpm format --check && pnpm knip
```

Coverage must be 100% lines and functions **honestly**. If a line is uncovered, add the missing test. If a line is genuinely unreachable, **stop and report** — do not lower the threshold, exclude a file, or add a test that executes a line without asserting anything about it. The `-http` plan wrongly called one branch unreachable; assume the same could be true here and check before believing it.

- [ ] **Step 9: Commit**

```bash
git add packages/start-temporal pnpm-lock.yaml
git commit -m "feat(start-temporal): add the contract middleware seam"
```

---

### Task 8: The package README

**Files:** Create `packages/start-temporal/README.md`

Sections, in order:

1. Title and one-line claim.
2. **Install** — the six peers, `Node >=20`, and that it is **not yet published**.
3. **Two worked examples** — the raw `asActivities` path and the `temporal-contract` `activityUnits` path, both real enough to compile against the exported types.
4. **What it owns** — the Worker's lifecycle, the unit boundary, the deadline race. And what it does **not**: `Result` → activity failure, which `declareActivitiesHandler` already does. State that explicitly; a reader coming from `-http` will expect the asymmetry to be explained.
5. **The drain, and the detached worker** — `worker.shutdown()` stops polling, `run()` settles on Temporal's clock, `@temporalio/worker` has no public forced shutdown, so at the kernel's deadline the runtime stops waiting and the worker keeps winding down until the process exits. Say this plainly; it is the package's one surprising behaviour.
6. **`forceAfter` and `gracePeriod`** — keep `forceAfter` at or below the kernel's `drainTimeoutMs`, and why the package cannot do that for you.
7. **The unit boundary** — one unit per **attempt**; `id` is the task token, `traceId` the workflow id, and why a workflow id would be wrong as the id.
8. **Writing a runtime** — the two contracts a runtime owes, and that this package discharges both.

Verify every claim against `src/temporal-runtime.ts` and `src/activity-units.ts` before writing it. Then `pnpm format` and commit as `docs(start-temporal): …`.

---

### Task 9: Documentation and changeset

**Files:** Modify `CLAUDE.md`, `README.md`; create `.changeset/start-temporal.md`

- [ ] **Step 1: `CLAUDE.md`** — strike `-temporal` from "Deferred, deliberately", leaving `-amqp` alone. Add `@btravstack/start-temporal` to the Shipped paragraph. Add a `### @btravstack/start-temporal` subsection to **Public surface** in the same density as the `-http` one. Update "two published packages" to three wherever it appears.

- [ ] **Step 2: Record what did not change** — add a line stating that `temporal-contract` needed no modification to compose, and why (its `ActivityMiddleware` is the seam, and `createContext` runs per activity execution). This is the conclusion the spec exists to preserve; without it the next person re-derives it.

- [ ] **Step 3: Root `README.md`** — remove the `-temporal` row from the deferred-packages table and adjust the surrounding sentence, which currently scopes "roughly forty lines" to `-amqp`/`-temporal`.

- [ ] **Step 4: Grep for claims this package falsifies** — `docs-examples.test-d.ts` is a **fifth** doc-sync target `CLAUDE.md` names; check it. Also check `packages/start/README.md`, `packages/start-http/README.md` and `examples/README.md` for "the only runtime" or "not written yet" phrasings.

- [ ] **Step 5: `.changeset/start-temporal.md`**

```markdown
---
"@btravstack/start-temporal": minor
---

The Temporal worker runtime for `@btravstack/start`.

`temporalRuntime({ connection, taskQueue, workflows, activities, needs })` runs a
Temporal worker under the kernel's lifecycle: one unit per activity attempt, and
a drain that releases the kernel at its **own** deadline rather than Temporal's
`shutdownForceTime` — `@temporalio/worker` exposes no public forced shutdown, so
stopping the wait is the only escalation available, and the worker keeps winding
down underneath until the process exits.

Two integrations, one package. `asActivities(host, impls)` wraps plain
implementations; `activityUnits(host)` is an `ActivityMiddleware` for
`temporal-contract` users, which costs them one line and no new dependency —
`temporal-contract` is not a peer. `Result` → activity failure is deliberately
not mapped here: `declareActivitiesHandler` already does it.
```

- [ ] **Step 6: Run all six gate commands** and commit as `docs: record @btravstack/start-temporal as shipped`.

---

## Self-Review

**Spec coverage.** Public surface → Tasks 2, 4, 7. `temporal-contract` needs no changes → Task 7 (the structural type) and Task 9 Step 2 (recorded). Lifecycle → 2, 6. Error handling → 3. Unit boundary → 4. Testing → 2–7. Package layout → 1. Docs → 8, 9. Out of scope → asserted by omission.

**Known risks, with their fallbacks written in rather than left to be discovered.**

1. **`workflowsPath` under vitest.** Task 2 points at a `.js` sibling; vitest's transform may not resolve it for the workflow bundler, which runs in its own worker. Fallback stated in the task: prebundle with `bundleFor` and report the change.
2. **Task 3 passes on arrival by design.** Task 2's qualification is already correct, so the task is characterisation with a proof-of-bite step rather than a red-green cycle, and says so. The `-http` plan claimed a red it could not produce; this one does not.
3. **Task 4 observes `UnitMeta` through a host proxy**, because `currentUnit()` exposes the kernel's `unitId` and not the meta's `id`. The proxy forwards to the real host and only records, so nothing is stubbed. A pre-flight scan caught the first draft asserting `expect.any(String)` while its title claimed the task token — if that assertion ever weakens back, it is testing nothing.
4. **The `as never` casts** in `asActivities` and `activityUnits`. Both are real: `host.run` is generic in `T`/`E` and a heterogeneous activity record erases them. Each needs an inline reason or a better signature. If a reviewer can remove one, it should be removed.
5. **100% coverage is a real constraint** and Task 7 enforces it. The `-http` plan wrongly declared one branch unreachable; the most likely candidates here are the `traceId` fallback to `activityId` (needs an activity started outside a workflow) and `whenAborted`'s already-aborted arm. Both look testable — check before believing otherwise.
