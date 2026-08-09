# `@btravstack/start` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@btravstack/start`, the application kernel that boots a `@btravstack/di` module into a running process with one runtime, and stops it again without losing in-flight work.

**Architecture:** A thin, opinionated wrapper over `Module.scoped`. The kernel owns a phase tracker, a unit registry (in-flight counting + abort), a probe server and signal handling; it delegates construction and teardown to `di` and transport concerns to a `Runtime` implementation it never inspects. Everything fallible returns an `unthrown` `Result`; the package never throws and never calls `process.exit`.

**Tech Stack:** TypeScript 7.0.2, `unthrown` 5.1.0 (peer), `@btravstack/di` (peer), `node:` builtins only. pnpm + turbo, tsdown (dual CJS/ESM), vitest + v8 coverage, oxlint/oxfmt, knip, changesets, lefthook + commitlint.

## Global Constraints

- **Runtime dependencies: none.** `unthrown` and `@btravstack/di` are **peer** dependencies (the dual-copy hazard: `di`'s port identity and `unthrown`'s `isResult` both compare across copies). `node:` builtins only otherwise.
- `engines: { node: ">=20" }`; `files: ["dist"]`; `sideEffects: false`; dual CJS/ESM via tsdown; `declarationMap: false`.
- TypeScript `strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`; ESM-first; `moduleResolution: NodeNext` — relative imports carry `.js`.
- oxlint rules are binding: no `interface` (use `type`), no `any` (use `unknown`). Genuine exceptions carry a targeted `oxlint-disable` **with a reason**.
- The repo dogfoods `@unthrown/oxlint`'s five recommended rules. No `throw` in library code except where a comment records why (`unthrown/no-throw` is opt-in and not enabled, but the convention holds).
- Gate, all green before any task is complete: `pnpm format --check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- Comment density: sparse. No comments in JSON files. Rationale belongs in `CLAUDE.md`, not inline.
- Conventional commits (`feat:`, `test:`, `docs:`, `chore:`).

## Deviations from the spec

Two, both deliberate, both to be reflected back into the spec when this plan is approved:

1. **`StartupFailure` does not include `ConstructionFailed`.** The spec proposed wrapping a construction failure in a kernel error. That erases the application's own modeled error type — a Thesis #1 violation. `Module.scoped` already reports the module's `E`, so `start` returns `AsyncResult<ExitReport, E | RuntimeStartFailed>` and the application's construction errors pass through **unwrapped and still typed**. `RuntimeStartFailed` remains, because it is genuinely the kernel's own error.
2. **`Clock.sleep` takes an `AbortSignal`.** The spec made the clock injectable without saying how a second signal cuts the `preDrainDelay` short. An abortable sleep is the mechanism.

---

### Task 1: Scaffold the workspace

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.oxlintrc.json`, `.oxfmtrc.json`, `knip.json`, `lefthook.yml`, `commitlint.config.js`, `.gitignore`, `.node-version`, `.changeset/config.json`
- Create: `packages/start/package.json`, `packages/start/tsconfig.json`, `packages/start/tsconfig.test-d.json`, `packages/start/vitest.config.ts`, `packages/start/src/index.ts`
- Test: `packages/start/src/index.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `pnpm test` / `pnpm build` / `pnpm lint` gate, and the package name `@btravstack/start` with subpath export `./testing`.

- [ ] **Step 1: Create the root workspace files**

`package.json`:

```json
{
  "name": "@btravstack/start-root",
  "private": true,
  "description": "The application kernel: boot a di module into a running process, and stop it without losing work",
  "license": "MIT",
  "author": "Benoit TRAVERS <benoit.travers.fr@gmail.com>",
  "type": "module",
  "scripts": {
    "build": "turbo run build",
    "changeset": "changeset",
    "dev": "turbo run dev",
    "format": "oxfmt .",
    "knip": "knip",
    "lint": "oxlint .",
    "prepare": "lefthook install",
    "release": "pnpm build && changeset publish",
    "test": "turbo run test",
    "test:types": "turbo run test:types",
    "typecheck": "turbo run typecheck",
    "version": "changeset version"
  },
  "devDependencies": {
    "@btravstack/commitlint": "catalog:",
    "@btravstack/lefthook": "catalog:",
    "@btravstack/oxlint": "catalog:",
    "@changesets/cli": "catalog:",
    "@commitlint/cli": "catalog:",
    "@unthrown/oxlint": "catalog:",
    "knip": "catalog:",
    "lefthook": "catalog:",
    "oxfmt": "catalog:",
    "oxlint": "catalog:",
    "turbo": "catalog:"
  },
  "engines": {
    "node": ">=22.19"
  },
  "packageManager": "pnpm@11.7.0"
}
```

`pnpm-workspace.yaml`:

```yaml
autoInstallPeers: false
dedupePeerDependents: true
engineStrict: true
saveExact: true
strictPeerDependencies: true

packages:
  - packages/*

catalog:
  "@btravstack/commitlint": 0.1.0
  "@btravstack/di": 0.1.0
  "@btravstack/lefthook": 0.1.1
  "@btravstack/oxlint": 0.2.1
  "@btravstack/tsconfig": 0.2.0
  "@changesets/cli": 2.31.1
  "@commitlint/cli": 21.2.1
  "@types/node": 26.1.2
  "@unthrown/oxlint": 5.1.0
  "@unthrown/vitest": 5.1.0
  knip: 6.32.0
  lefthook: 2.1.10
  oxfmt: 0.62.0
  oxlint: 1.77.0
  tsdown: 0.22.14
  turbo: 2.10.8
  typescript: 7.0.2
  unthrown: 5.1.0
  "@vitest/coverage-v8": 4.1.10
  vitest: 4.1.10

allowBuilds:
  esbuild: true
  lefthook: true
```

`turbo.json`:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "lint": { "dependsOn": ["^build"] },
    "format": {},
    "typecheck": { "dependsOn": ["build"] },
    "test:types": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"], "cache": false },
    "dev": { "dependsOn": ["^build"], "cache": false, "persistent": true },
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] }
  }
}
```

`.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "extends": ["./node_modules/@btravstack/oxlint/base.json"],
  "ignorePatterns": ["**/*.test-d.ts"],
  "jsPlugins": [{ "name": "unthrown", "specifier": "@unthrown/oxlint" }],
  "rules": {
    "unthrown/no-ambiguous-error-type": "error",
    "unthrown/no-catch-all-pattern": "error",
    "unthrown/no-unhandled-result": "error",
    "unthrown/no-unused-matcher": "error",
    "unthrown/prefer-async-result": "error"
  }
}
```

`.oxfmtrc.json`:

```json
{
  "$schema": "./node_modules/oxfmt/configuration_schema.json",
  "ignorePatterns": ["pnpm-lock.yaml", ".claude/"],
  "sortImports": true,
  "overrides": [{ "files": ["**/*.md"], "options": { "printWidth": 80 } }]
}
```

`knip.json`:

```json
{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  "ignoreExportsUsedInFile": true,
  "ignore": ["**/*.test-d.ts"],
  "ignoreDependencies": ["@btravstack/lefthook", "@btravstack/oxlint"]
}
```

`lefthook.yml`:

```yaml
extends:
  - node_modules/@btravstack/lefthook/lefthook.yml

pre-commit:
  commands:
    format:
      exclude:
        - "pnpm-lock.yaml"
    lint:
      exclude:
        - "*.test-d.ts"
```

`commitlint.config.js`:

```js
export default { extends: ["@btravstack/commitlint"] };
```

`.node-version`:

```
24.16.0
```

`.gitignore` — note the deliberate omission of a `docs/superpowers/` entry, which the sibling repos ignore. This repo is built *from* a committed spec, so its design documents are tracked:

```
node_modules/
**/dist/
*.tsbuildinfo
coverage/
*.lcov
.turbo/
*.log
.env
.env.*
!.env.example
.vscode/
.idea/
.DS_Store
```

`.changeset/config.json`:

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.1.1/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

- [ ] **Step 2: Create the package files**

`packages/start/package.json`:

```json
{
  "name": "@btravstack/start",
  "version": "0.1.0",
  "description": "The application kernel: boot a di module into a running process, and stop it without losing work",
  "keywords": [
    "application",
    "bootstrap",
    "dependency-injection",
    "graceful-shutdown",
    "kernel",
    "lifecycle",
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
    "directory": "packages/start"
  },
  "files": ["dist"],
  "type": "module",
  "sideEffects": false,
  "main": "./dist/index.cjs",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.cts",
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.mts", "default": "./dist/index.mjs" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
    },
    "./testing": {
      "import": { "types": "./dist/testing.d.mts", "default": "./dist/testing.mjs" },
      "require": { "types": "./dist/testing.d.cts", "default": "./dist/testing.cjs" }
    },
    "./package.json": "./package.json"
  },
  "scripts": {
    "build": "tsdown src/index.ts src/testing.ts --format cjs,esm --dts --clean",
    "dev": "tsdown src/index.ts src/testing.ts --format cjs,esm --dts --watch",
    "test": "vitest run",
    "test:types": "tsc --noEmit -p tsconfig.test-d.json",
    "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.test-d.json"
  },
  "devDependencies": {
    "@btravstack/di": "catalog:",
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
    "unthrown": "^5.0.0"
  },
  "engines": { "node": ">=20" }
}
```

`packages/start/tsconfig.json`:

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
  "exclude": ["node_modules", "dist", "src/**/*.test-d.ts"]
}
```

`packages/start/tsconfig.test-d.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noUnusedLocals": false, "noUnusedParameters": false },
  "include": ["src/**/*.test-d.ts"],
  "exclude": ["node_modules", "dist"]
}
```

`packages/start/vitest.config.ts`:

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
      exclude: ["src/**/*.spec.ts", "src/**/*.test-d.ts", "src/testing.ts"],
      thresholds: { lines: 100, functions: 100 },
    },
  },
});
```

`packages/start/src/index.ts`:

```ts
export const VERSION = "0.1.0";
```

- [ ] **Step 3: Write the smoke test**

`packages/start/src/index.spec.ts`:

```ts
import { describe, expect, it } from "vitest";

import { VERSION } from "./index.js";

describe("package", () => {
  it("exports a version", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
```

- [ ] **Step 4: Install and run the gate**

Run:

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Expected: all five pass; `packages/start/dist/` contains `index.mjs`, `index.cjs`, `index.d.mts`, `index.d.cts`.

Note: `src/testing.ts` does not exist yet, so remove `src/testing.ts` from the `build`/`dev` scripts for this task only and restore it in Task 12. If `pnpm install` fails on `@btravstack/di@0.1.0` not being published yet, add `"@btravstack/di": "link:../../../di/packages/di"` to `packages/start/package.json`'s `devDependencies` instead of the catalog entry, and record that in the changeset.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold the workspace"
```

---

### Task 2: Phase tracker and kernel events

**Files:**
- Create: `packages/start/src/phase.ts`, `packages/start/src/events.ts`
- Test: `packages/start/src/phase.spec.ts`, `packages/start/src/events.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Phase = "building" | "starting" | "serving" | "draining" | "stopping" | "exited"`
  - `createPhaseTracker(onChange: (phase: Phase) => void): PhaseTracker` where `PhaseTracker = { current: () => Phase; advanceTo: (phase: Phase) => boolean }`
  - `type KernelEvent`, `type EventSink = (event: KernelEvent) => void`, `stderrSink: EventSink`, `safeSink(sink: EventSink): EventSink`

- [ ] **Step 1: Write the failing phase tests**

`packages/start/src/phase.spec.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createPhaseTracker } from "./phase.js";

describe("createPhaseTracker", () => {
  it("starts in building and reports each advance", () => {
    const seen: string[] = [];
    const tracker = createPhaseTracker((phase) => seen.push(phase));

    expect(tracker.current()).toBe("building");
    expect(tracker.advanceTo("serving")).toBe(true);
    expect(tracker.current()).toBe("serving");
    expect(seen).toEqual(["serving"]);
  });

  it("refuses to move backwards and reports nothing", () => {
    const seen: string[] = [];
    const tracker = createPhaseTracker((phase) => seen.push(phase));
    tracker.advanceTo("stopping");

    expect(tracker.advanceTo("draining")).toBe(false);
    expect(tracker.current()).toBe("stopping");
    expect(seen).toEqual(["stopping"]);
  });

  it("treats re-entering the same phase as a no-op", () => {
    const seen: string[] = [];
    const tracker = createPhaseTracker((phase) => seen.push(phase));
    tracker.advanceTo("draining");

    expect(tracker.advanceTo("draining")).toBe(false);
    expect(seen).toEqual(["draining"]);
  });
});
```

The backwards guard is the load-bearing part: a second SIGTERM arriving while draining, and a runtime failing at the same moment, both try to advance. `advanceTo` returning `false` is how the caller learns it lost the race and must not run the transition's side effects twice.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @btravstack/start test -- phase`
Expected: FAIL — `Failed to resolve import "./phase.js"`.

- [ ] **Step 3: Implement `phase.ts`**

```ts
export type Phase = "building" | "starting" | "serving" | "draining" | "stopping" | "exited";

const ORDER: readonly Phase[] = [
  "building",
  "starting",
  "serving",
  "draining",
  "stopping",
  "exited",
];

const rank = (phase: Phase): number => ORDER.indexOf(phase);

export type PhaseTracker = {
  readonly current: () => Phase;
  readonly advanceTo: (phase: Phase) => boolean;
};

export const createPhaseTracker = (onChange: (phase: Phase) => void): PhaseTracker => {
  let phase: Phase = "building";

  return {
    current: () => phase,
    advanceTo: (next) => {
      if (rank(next) <= rank(phase)) return false;
      phase = next;
      onChange(next);
      return true;
    },
  };
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @btravstack/start test -- phase`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing events test**

`packages/start/src/events.spec.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { safeSink, stderrSink } from "./events.js";

describe("safeSink", () => {
  it("forwards events to the wrapped sink", () => {
    const calls: unknown[] = [];
    const sink = safeSink((event) => calls.push(event));

    sink({ type: "serving", runtime: "test" });

    expect(calls).toEqual([{ type: "serving", runtime: "test" }]);
  });

  it("swallows a throwing sink", () => {
    const sink = safeSink(() => {
      throw new Error("broken reporter");
    });

    expect(() => sink({ type: "building" })).not.toThrow();
  });
});

describe("stderrSink", () => {
  it("writes one JSON line per event", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    stderrSink({ type: "draining", inFlight: 2 });

    expect(write).toHaveBeenCalledWith('{"type":"draining","inFlight":2}\n');
    write.mockRestore();
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter @btravstack/start test -- events`
Expected: FAIL — `Failed to resolve import "./events.js"`.

- [ ] **Step 7: Implement `events.ts`**

```ts
import type { DrainReport } from "./drain-report.js";

export type KernelEvent =
  | { readonly type: "building" }
  | { readonly type: "serving"; readonly runtime: string }
  | { readonly type: "draining"; readonly inFlight: number }
  | { readonly type: "drained"; readonly report: DrainReport }
  | { readonly type: "stopping" }
  | { readonly type: "exited" }
  | { readonly type: "teardownError"; readonly port: string; readonly cause: unknown }
  | { readonly type: "uncaught"; readonly cause: unknown };

export type EventSink = (event: KernelEvent) => void;

export const stderrSink: EventSink = (event) => {
  process.stderr.write(`${JSON.stringify(event)}\n`);
};

// A broken reporter must not take the process down mid-shutdown — the same
// rule di applies to a throwing `onTeardownError`. There is nowhere left to
// report a broken reporter to.
export const safeSink =
  (sink: EventSink): EventSink =>
  (event) => {
    try {
      sink(event);
    } catch {
      // deliberately swallowed
    }
  };
```

Also create `packages/start/src/drain-report.ts` now, since `events.ts` imports it and Task 7 fills in its use:

```ts
export type DrainReport = {
  readonly inFlightAtStart: number;
  readonly completed: number;
  readonly abandoned: number;
};
```

- [ ] **Step 8: Run to verify it passes**

Run: `pnpm --filter @btravstack/start test`
Expected: PASS (6 tests).

- [ ] **Step 9: Commit**

```bash
git add packages/start/src/phase.ts packages/start/src/phase.spec.ts \
        packages/start/src/events.ts packages/start/src/events.spec.ts \
        packages/start/src/drain-report.ts
git commit -m "feat: add the phase tracker and kernel events"
```

---

### Task 3: The injectable clock

**Files:**
- Create: `packages/start/src/clock.ts`
- Test: `packages/start/src/clock.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Clock = { now: () => number; sleep: (ms: number, signal?: AbortSignal) => Promise<void> }`, `systemClock: Clock`.

`sleep` resolves early — it does not reject — when the signal aborts. A rejection here would have to be qualified by every caller, and "the wait was cut short" is not a failure: the caller checks `signal.aborted` if it cares.

- [ ] **Step 1: Write the failing test**

`packages/start/src/clock.spec.ts`:

```ts
import { describe, expect, it } from "vitest";

import { systemClock } from "./clock.js";

describe("systemClock", () => {
  it("reports a moving now", () => {
    const before = systemClock.now();
    expect(typeof before).toBe("number");
    expect(before).toBeGreaterThan(0);
  });

  it("sleeps for the requested duration", async () => {
    const before = systemClock.now();
    await systemClock.sleep(20);
    expect(systemClock.now() - before).toBeGreaterThanOrEqual(15);
  });

  it("resolves early when the signal aborts, without rejecting", async () => {
    const controller = new AbortController();
    const before = systemClock.now();
    const sleeping = systemClock.sleep(5_000, controller.signal);
    controller.abort();

    await expect(sleeping).resolves.toBeUndefined();
    expect(systemClock.now() - before).toBeLessThan(1_000);
  });

  it("resolves immediately when the signal is already aborted", async () => {
    await expect(systemClock.sleep(5_000, AbortSignal.abort())).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @btravstack/start test -- clock`
Expected: FAIL — `Failed to resolve import "./clock.js"`.

- [ ] **Step 3: Implement `clock.ts`**

```ts
export type Clock = {
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      // The kernel's sleeps happen during shutdown; an outstanding timer must
      // not be the reason the event loop stays alive.
      timer.unref?.();

      function onAbort(): void {
        clearTimeout(timer);
        resolve();
      }

      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @btravstack/start test -- clock`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/start/src/clock.ts packages/start/src/clock.spec.ts
git commit -m "feat: add the injectable clock"
```

---

### Task 4: The ambient unit record

**Files:**
- Create: `packages/start/src/ambient.ts`
- Test: `packages/start/src/ambient.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type UnitRecord`, `runWithUnit<T>(record: UnitRecord, fn: () => T): T`, `currentUnit(): UnitRecord | undefined`.

This is the whole of the "ambient carries data, `Context` carries capabilities" rule at runtime: a fixed record of scalars, and no way to put a service in it.

- [ ] **Step 1: Write the failing test**

`packages/start/src/ambient.spec.ts`:

```ts
import { describe, expect, it } from "vitest";

import { currentUnit, runWithUnit } from "./ambient.js";

const record = {
  unitId: "u-1",
  traceId: "t-1",
  tenantId: "acme",
  deadline: undefined,
} as const;

describe("ambient unit record", () => {
  it("is undefined outside a unit", () => {
    expect(currentUnit()).toBeUndefined();
  });

  it("is readable inside a unit", () => {
    const seen = runWithUnit(record, () => currentUnit());
    expect(seen).toEqual(record);
  });

  it("survives an await boundary", async () => {
    const seen = await runWithUnit(record, async () => {
      await Promise.resolve();
      return currentUnit();
    });
    expect(seen?.unitId).toBe("u-1");
  });

  it("does not leak between concurrent units", async () => {
    const [a, b] = await Promise.all([
      runWithUnit({ ...record, unitId: "a" }, async () => {
        await Promise.resolve();
        return currentUnit()?.unitId;
      }),
      runWithUnit({ ...record, unitId: "b" }, async () => {
        await Promise.resolve();
        return currentUnit()?.unitId;
      }),
    ]);

    expect([a, b]).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @btravstack/start test -- ambient`
Expected: FAIL — `Failed to resolve import "./ambient.js"`.

- [ ] **Step 3: Implement `ambient.ts`**

```ts
import { AsyncLocalStorage } from "node:async_hooks";

export type UnitRecord = {
  readonly unitId: string;
  readonly traceId: string;
  readonly tenantId: string | undefined;
  readonly deadline: number | undefined;
};

const storage = new AsyncLocalStorage<UnitRecord>();

export const runWithUnit = <T>(record: UnitRecord, fn: () => T): T => storage.run(record, fn);

export const currentUnit = (): UnitRecord | undefined => storage.getStore();
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @btravstack/start test -- ambient`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/start/src/ambient.ts packages/start/src/ambient.spec.ts
git commit -m "feat: add the ambient unit record"
```

---

### Task 5: The unit registry

**Files:**
- Create: `packages/start/src/units.ts`
- Test: `packages/start/src/units.spec.ts`

**Interfaces:**
- Consumes: `runWithUnit`, `UnitRecord` (Task 4).
- Produces:
  - `type UnitMeta = { kind: string; id: string; traceId?: string; tenantId?: string; deadline?: number }`
  - `type UnitRegistry = { run: <T, E>(meta: UnitMeta, work: (signal: AbortSignal) => AsyncResult<T, E>) => AsyncResult<T, E>; inFlight: () => number; abortAll: () => void; awaitIdle: () => Promise<void> }`
  - `createUnitRegistry(): UnitRegistry`

- [ ] **Step 1: Write the failing test**

`packages/start/src/units.spec.ts`:

```ts
import { Err, Ok } from "unthrown";
import { describe, expect, it } from "vitest";

import { currentUnit } from "./ambient.js";
import { createUnitRegistry } from "./units.js";

const meta = { kind: "test", id: "1" };

describe("createUnitRegistry", () => {
  it("returns the work's result unchanged", async () => {
    const registry = createUnitRegistry();
    await expect(registry.run(meta, () => Ok(42).toAsync())).toBeOkWith(42);
  });

  it("passes the error channel through", async () => {
    const registry = createUnitRegistry();
    await expect(registry.run(meta, () => Err("nope" as const).toAsync())).toBeErrWith("nope");
  });

  it("counts a unit as in flight until it settles", async () => {
    const registry = createUnitRegistry();
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const running = registry.run(meta, async () => {
      await held;
      return Ok("done");
    });

    expect(registry.inFlight()).toBe(1);
    release();
    await running;
    expect(registry.inFlight()).toBe(0);
  });

  it("decrements even when the work throws", async () => {
    const registry = createUnitRegistry();

    await expect(
      registry.run(meta, () => {
        throw new Error("boom");
      }),
    ).toBeDefect();
    expect(registry.inFlight()).toBe(0);
  });

  it("exposes the ambient record to the work", async () => {
    const registry = createUnitRegistry();

    const seen = await registry.run({ ...meta, tenantId: "acme" }, () =>
      Ok(currentUnit()).toAsync(),
    );

    expect(seen).toBeOkWith(expect.objectContaining({ tenantId: "acme" }));
  });

  it("aborts every open unit on abortAll", async () => {
    const registry = createUnitRegistry();
    let aborted = false;

    const running = registry.run(meta, async (signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      await Promise.resolve();
      return Ok("done");
    });

    registry.abortAll();
    await running;
    expect(aborted).toBe(true);
  });

  it("awaitIdle resolves immediately when nothing is in flight", async () => {
    const registry = createUnitRegistry();
    await expect(registry.awaitIdle()).resolves.toBeUndefined();
  });

  it("awaitIdle resolves once the last unit settles", async () => {
    const registry = createUnitRegistry();
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = registry.run(meta, async () => {
      await held;
      return Ok("done");
    });

    let idle = false;
    void registry.awaitIdle().then(() => {
      idle = true;
    });

    expect(idle).toBe(false);
    release();
    await running;
    await Promise.resolve();
    expect(idle).toBe(true);
  });
});
```

Note the work callbacks here are `async` and return a `Result` — that is a `Promise<Result>`, which `run` accepts because it awaits internally. `run`'s own return is an `AsyncResult`, so a caller still cannot bypass qualification.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @btravstack/start test -- units`
Expected: FAIL — `Failed to resolve import "./units.js"`.

- [ ] **Step 3: Implement `units.ts`**

```ts
import { fromSafePromise, type AsyncResult, type Result } from "unthrown";

import { runWithUnit, type UnitRecord } from "./ambient.js";

export type UnitMeta = {
  readonly kind: string;
  readonly id: string;
  readonly traceId?: string;
  readonly tenantId?: string;
  readonly deadline?: number;
};

export type UnitWork<T, E> = (
  signal: AbortSignal,
) => AsyncResult<T, E> | Promise<Result<T, E>> | Result<T, E>;

export type UnitRegistry = {
  readonly run: <T, E>(meta: UnitMeta, work: UnitWork<T, E>) => AsyncResult<T, E>;
  readonly inFlight: () => number;
  readonly abortAll: () => void;
  readonly awaitIdle: () => Promise<void>;
};

let counter = 0;

const nextId = (): string => {
  counter += 1;
  return `u${counter}`;
};

export const createUnitRegistry = (): UnitRegistry => {
  const open = new Set<AbortController>();
  const idleWaiters = new Set<() => void>();

  const settleIfIdle = (): void => {
    if (open.size > 0) return;
    for (const waiter of idleWaiters) waiter();
    idleWaiters.clear();
  };

  return {
    run: (meta, work) => {
      const controller = new AbortController();
      open.add(controller);

      const record: UnitRecord = {
        unitId: nextId(),
        traceId: meta.traceId ?? meta.id,
        tenantId: meta.tenantId,
        deadline: meta.deadline,
      };

      // `fromSafePromise` is correct rather than `fromPromise`: the promise
      // below cannot reject — the work's own throw is caught by `flatMap`'s
      // throw-to-defect net once the inner Result is unwrapped — and there is
      // no cause here that a `qualify` could triage into a modeled error.
      return fromSafePromise(
        runWithUnit(record, async () => {
          try {
            return await work(controller.signal);
          } finally {
            open.delete(controller);
            settleIfIdle();
          }
        }),
      ).flatMap((result) => result);
    },
    inFlight: () => open.size,
    abortAll: () => {
      for (const controller of open) controller.abort();
    },
    awaitIdle: () =>
      open.size === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            idleWaiters.add(resolve);
          }),
  };
};
```

A throwing `work` rejects the promise `fromSafePromise` wraps, which becomes a `Defect` — matching the `decrements even when the work throws` test, and matching core's throw-to-defect rule.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @btravstack/start test -- units`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/start/src/units.ts packages/start/src/units.spec.ts
git commit -m "feat: add the unit registry"
```

---

### Task 6: The Runtime contract and the test runtime

**Files:**
- Create: `packages/start/src/runtime.ts`, `packages/start/src/test-runtime.ts`
- Test: `packages/start/src/test-runtime.spec.ts`

**Interfaces:**
- Consumes: `UnitMeta`, `UnitWork` (Task 5); `Context`, `AnyPort` from `@btravstack/di`.
- Produces:
  - `class RuntimeStartFailed extends TaggedError("RuntimeStartFailed")<{ runtime: string; cause: unknown }>`
  - `type RunUnit<Needs>`, `type RuntimeHost<Needs>`, `type Runtime<Needs>`, `type Serving`
  - `testRuntime(): TestRuntime` where `TestRuntime = Runtime<never> & { submit: <T>(work) => { settle: (value: T) => void; result: Promise<...> }; started: () => boolean }`

- [ ] **Step 1: Write `runtime.ts` (types plus one error class)**

```ts
import { TaggedError, type AsyncResult } from "unthrown";
import type { AnyPort, Context } from "@btravstack/di";

import type { DrainReport } from "./drain-report.js";
import type { UnitMeta, UnitWork } from "./units.js";

export class RuntimeStartFailed extends TaggedError("RuntimeStartFailed")<{
  readonly runtime: string;
  readonly cause: unknown;
}> {
  override message = `the ${this.runtime} runtime failed to start`;
}

export type RunUnit<Needs extends AnyPort> = <T, E>(
  meta: UnitMeta,
  work: (ctx: Context<Needs>, signal: AbortSignal) => ReturnType<UnitWork<T, E>>,
) => AsyncResult<T, E>;

export type RuntimeHost<Needs extends AnyPort> = {
  readonly ctx: Context<Needs>;
  readonly run: RunUnit<Needs>;
};

export type Serving = {
  readonly drain: (signal: AbortSignal) => AsyncResult<DrainReport, never>;
  readonly stop: () => AsyncResult<void, never>;
};

export type Runtime<Needs extends AnyPort> = {
  readonly name: string;
  readonly needs: readonly Needs[];
  readonly start: (host: RuntimeHost<Needs>) => AsyncResult<Serving, RuntimeStartFailed>;
};
```

`Serving.drain` receives the deadline as an `AbortSignal` rather than a timestamp — the kernel already owns the clock and fires the signal at the deadline, so a runtime never does arithmetic on time. This settles the spec's second open question.

`Context` is declared `in R` (contravariant) in `di`, so an application `Context<Exports>` is assignable to `Context<Needs>` exactly when `Needs ⊆ Exports`. The compile-time check the spec asks for therefore needs no machinery — it is ordinary assignability at the `start` call.

- [ ] **Step 2: Write the failing test runtime test**

`packages/start/src/test-runtime.spec.ts`:

```ts
import { Context } from "@btravstack/di";
import { Ok } from "unthrown";
import { describe, expect, it } from "vitest";

import { createUnitRegistry } from "./units.js";
import { testRuntime } from "./test-runtime.js";

// `registry.run`'s work takes `(signal)`; a `RunUnit`'s takes `(ctx, signal)`.
// The kernel is what closes over the context and adapts between them — this
// stub does the same thing `start.ts` does in Task 7.
const hostFor = (registry = createUnitRegistry()) => {
  const ctx = Context.empty();
  return {
    ctx,
    run: (<T, E>(meta: UnitMeta, work: (c: typeof ctx, s: AbortSignal) => never) =>
      registry.run<T, E>(meta, (signal) => work(ctx, signal))) as RunUnit<never>,
  };
};

describe("testRuntime", () => {
  it("starts and reports itself started", async () => {
    const runtime = testRuntime();
    const serving = await runtime.start(hostFor());

    expect(serving).toBeOk();
    expect(runtime.started()).toBe(true);
  });

  it("routes submitted work through the registry", async () => {
    const registry = createUnitRegistry();
    const runtime = testRuntime();
    await runtime.start(hostFor(registry));

    const unit = runtime.submit();
    expect(registry.inFlight()).toBe(1);

    unit.settle(Ok("done"));
    await expect(unit.result).toBeOkWith("done");
    expect(registry.inFlight()).toBe(0);
  });

  it("refuses work after drain has begun", async () => {
    const runtime = testRuntime();
    await runtime.start(hostFor());
    const serving = runtime.serving();

    void serving.drain(new AbortController().signal);

    expect(() => runtime.submit()).toThrow("not accepting");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @btravstack/start test -- test-runtime`
Expected: FAIL — `Failed to resolve import "./test-runtime.js"`.

- [ ] **Step 4: Implement `test-runtime.ts`**

```ts
import { Ok, type AsyncResult, type Result } from "unthrown";

import type { DrainReport } from "./drain-report.js";
import type { Runtime, RuntimeHost, Serving } from "./runtime.js";
import type { RunUnit } from "./runtime.js";

export type SubmittedUnit<T, E> = {
  readonly settle: (result: Result<T, E>) => void;
  readonly result: AsyncResult<T, E>;
  readonly signal: AbortSignal;
};

export type TestRuntime = Runtime<never> & {
  readonly started: () => boolean;
  readonly serving: () => Serving;
  readonly submit: <T = string, E = never>() => SubmittedUnit<T, E>;
};

export const testRuntime = (name = "test"): TestRuntime => {
  let run: RunUnit<never> | undefined;
  let accepting = false;
  let serving: Serving | undefined;
  let submitted = 0;
  let completed = 0;

  const make = (): Serving => ({
    drain: (signal) => {
      accepting = false;
      void signal;
      const report: DrainReport = {
        inFlightAtStart: submitted - completed,
        completed,
        abandoned: 0,
      };
      return Ok(report).toAsync();
    },
    stop: () => {
      accepting = false;
      return Ok(undefined).toAsync();
    },
  });

  return {
    name,
    needs: [],
    start: (host: RuntimeHost<never>) => {
      run = host.run;
      accepting = true;
      serving = make();
      return Ok(serving).toAsync();
    },
    started: () => serving !== undefined,
    serving: () => {
      if (serving === undefined) {
        // A test-only fixture: reaching here means the test forgot to start
        // the runtime, which is a bug in the test, not a modeled outcome.
        // (No `oxlint-disable` needed — `unthrown/no-throw` is opt-in and this
        // repo does not enable it; an unused disable directive is itself a
        // lint warning.)
        throw new Error("[test-runtime] not started");
      }
      return serving;
    },
    submit: <T, E>() => {
      if (run === undefined || !accepting) {
        // Same rationale as above: a test asserting post-drain behaviour wants
        // this to be loud, not routed.
        throw new Error("[test-runtime] not accepting work");
      }

      submitted += 1;
      let settle!: (result: Result<T, E>) => void;
      const held = new Promise<Result<T, E>>((resolve) => {
        settle = resolve;
      });
      let signal!: AbortSignal;

      const result = run<T, E>({ kind: "test", id: `${submitted}` }, async (_ctx, s) => {
        signal = s;
        const value = await held;
        completed += 1;
        return value;
      });

      return { settle, result, get signal() { return signal; } };
    },
  };
};
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @btravstack/start test -- test-runtime`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/start/src/runtime.ts packages/start/src/test-runtime.ts \
        packages/start/src/test-runtime.spec.ts
git commit -m "feat: add the Runtime contract and the test runtime"
```

---

### Task 7: `start` — build, serve, stop

**Files:**
- Create: `packages/start/src/start.ts`, `packages/start/src/deferred.ts`
- Modify: `packages/start/src/index.ts`
- Test: `packages/start/src/start.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–6, plus `Module`, `Context`, `AnyPort` from `@btravstack/di`.
- Produces:
  - `type ExitReport = { reason: "signal" | "runtimeStopped" | "uncaught"; drain: DrainReport | undefined; teardownErrors: readonly { port: string; cause: unknown }[]; uptimeMs: number }`
  - `type StartOptions<Needs>`, `type RunningApp`
  - `start<X, E, Needs>(module: Module<X, E, never>, options: StartOptions<Needs>): AsyncResult<ExitReport, E | RuntimeStartFailed>`

This task delivers the happy path and the startup-failure path. Drain, signals, uncaught handlers and probes arrive in Tasks 8–11; `stop()` here is the immediate form.

- [ ] **Step 1: Write `deferred.ts`**

```ts
export type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly settled: () => boolean;
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
    settled: () => settled,
  };
};
```

- [ ] **Step 2: Write the failing test**

`packages/start/src/start.spec.ts`:

```ts
import { Module, Port, Provider } from "@btravstack/di";
import { Err, Ok } from "unthrown";
import { describe, expect, it } from "vitest";

import { start } from "./start.js";
import { testRuntime } from "./test-runtime.js";

class Greeting extends Port("Greeting")<{ readonly text: string }> {}

const AppModule = Module("App")({
  provides: [Provider(Greeting)({ value: { text: "hello" } })],
  exports: [Greeting],
});

describe("start", () => {
  it("builds the graph, serves, and exits cleanly when stopped", async () => {
    const runtime = testRuntime();
    const app = start(AppModule, { runtime, signals: false, probes: false });

    await runtime.untilStarted();
    expect(runtime.started()).toBe(true);

    app.stop();

    const report = await app.exited;
    expect(report).toBeOkWith(
      expect.objectContaining({ reason: "runtimeStopped", teardownErrors: [] }),
    );
  });

  it("reports a construction failure without wrapping the module's own error", async () => {
    const Failing = Module("Failing")({
      provides: [Provider(Greeting)({ make: () => Err("no-config" as const).toAsync() })],
      exports: [Greeting],
    });

    const app = start(Failing, { runtime: testRuntime(), signals: false, probes: false });

    await expect(app.exited).toBeErrWith("no-config");
  });

  it("reports a runtime that refuses to start", async () => {
    const broken = {
      ...testRuntime(),
      start: () => Err(new RuntimeStartFailed({ runtime: "broken", cause: "port in use" })).toAsync(),
    };

    const app = start(AppModule, { runtime: broken, signals: false, probes: false });

    await expect(app.exited).toBeErrTagged("RuntimeStartFailed", { runtime: "broken" });
  });

  it("closes the application scope on a clean stop", async () => {
    const released: string[] = [];
    const Resourceful = Module("Resourceful")({
      provides: [
        Provider(Greeting)({
          acquire: () => Ok({ text: "hi" }).toAsync(),
          release: () => {
            released.push("greeting");
          },
        }),
      ],
      exports: [Greeting],
    });

    const runtime = testRuntime();
    const app = start(Resourceful, { runtime, signals: false, probes: false });
    await runtime.untilStarted();
    app.stop();
    await app.exited;

    expect(released).toEqual(["greeting"]);
  });
});
```

Add `untilStarted(): Promise<void>` to `test-runtime.ts` — a deferred resolved inside `start` — since `start` no longer settles once the runtime is serving.

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @btravstack/start test -- start`
Expected: FAIL — `Failed to resolve import "./start.js"`.

- [ ] **Step 4: Implement `start.ts`**

```ts
import { Module, type AnyPort, type Context } from "@btravstack/di";
import { Ok, type AsyncResult } from "unthrown";

import { createDeferred } from "./deferred.js";
import type { DrainReport } from "./drain-report.js";
import { safeSink, stderrSink, type EventSink } from "./events.js";
import { createPhaseTracker, type Phase } from "./phase.js";
import { systemClock, type Clock } from "./clock.js";
import type { Runtime, RuntimeStartFailed, Serving } from "./runtime.js";
import { createUnitRegistry } from "./units.js";

export type TeardownError = { readonly port: string; readonly cause: unknown };

export type ExitReport = {
  readonly reason: "signal" | "runtimeStopped" | "uncaught";
  readonly drain: DrainReport | undefined;
  readonly teardownErrors: readonly TeardownError[];
  readonly uptimeMs: number;
};

export type StartOptions<Needs extends AnyPort> = {
  readonly runtime: Runtime<Needs>;
  readonly clock?: Clock;
  readonly signals?: boolean;
  readonly probes?: { readonly port: number } | false;
  readonly preDrainDelayMs?: number;
  readonly drainTimeoutMs?: number;
  readonly onEvent?: EventSink;
};

export type RunningApp<E> = {
  readonly exited: AsyncResult<ExitReport, E | RuntimeStartFailed>;
  readonly stop: () => void;
  readonly phase: () => Phase;
};

export const start = <X extends AnyPort, E, Needs extends AnyPort>(
  module: Module<X, E, never>,
  options: StartOptions<Needs>,
): RunningApp<E> => {
  const clock = options.clock ?? systemClock;
  const emit = safeSink(options.onEvent ?? stderrSink);
  const tracker = createPhaseTracker((phase) => {
    if (phase === "serving") emit({ type: "serving", runtime: options.runtime.name });
    if (phase === "stopping") emit({ type: "stopping" });
    if (phase === "exited") emit({ type: "exited" });
  });

  const registry = createUnitRegistry();
  const shutdown = createDeferred<ExitReport["reason"]>();
  const teardownErrors: TeardownError[] = [];
  const startedAt = clock.now();

  emit({ type: "building" });

  const exited = Module.scoped(
    module,
    (ctx: Context<X>): AsyncResult<ExitReport, RuntimeStartFailed> => {
      tracker.advanceTo("starting");

      // `Context<in R>` is contravariant, so an application context whose
      // exports cover the runtime's needs is assignable here; the cast is only
      // because `X` and `Needs` are unrelated type parameters at this point,
      // and the assignability is enforced at the public `start` call.
      const runtimeCtx = ctx as unknown as Context<Needs>;

      // The registry counts and aborts; it knows nothing about contexts. The
      // kernel is what closes over `runtimeCtx` and hands a runtime the
      // two-argument `RunUnit` its handlers expect. When the `unit` module
      // lands (deferred, see the end of this plan), the `Module.forkScope`
      // call goes exactly here, replacing `runtimeCtx` with the fork's context.
      const run = (<T, E>(
        meta: UnitMeta,
        work: (c: Context<Needs>, signal: AbortSignal) => ReturnType<UnitWork<T, E>>,
      ) => registry.run<T, E>(meta, (signal) => work(runtimeCtx, signal))) as RunUnit<Needs>;

      const host = { ctx: runtimeCtx, run };

      return options.runtime.start(host).flatMap((serving: Serving) => {
        tracker.advanceTo("serving");

        return fromShutdown(shutdown.promise).flatMap((reason) =>
          finish(serving, reason, tracker, registry, clock, startedAt, teardownErrors),
        );
      });
    },
    {
      onTeardownError: (port, cause) => {
        teardownErrors.push({ port, cause });
        emit({ type: "teardownError", port, cause });
      },
    },
  );

  return {
    exited: exited as AsyncResult<ExitReport, E | RuntimeStartFailed>,
    stop: () => shutdown.resolve("runtimeStopped"),
    phase: tracker.current,
  };
};
```

with two helpers in the same file:

```ts
import { fromSafePromise } from "unthrown";

const fromShutdown = (promise: Promise<ExitReport["reason"]>) =>
  fromSafePromise(promise).map((reason) => reason);

const finish = (
  serving: Serving,
  reason: ExitReport["reason"],
  tracker: ReturnType<typeof createPhaseTracker>,
  registry: ReturnType<typeof createUnitRegistry>,
  clock: Clock,
  startedAt: number,
  teardownErrors: readonly TeardownError[],
): AsyncResult<ExitReport, never> => {
  tracker.advanceTo("stopping");

  return serving.stop().map(() => {
    tracker.advanceTo("exited");
    return {
      reason,
      drain: undefined,
      teardownErrors,
      uptimeMs: clock.now() - startedAt,
    };
  });
};
```

Note `Module<X, E, never>`: the kernel accepts only a module with no unmet needs other than `Scope`, which `Module.scoped` discharges. A module with genuine unmet needs fails `di`'s own UNSATISFIED DEPENDENCIES gate at this call.

- [ ] **Step 5: Export from `index.ts`**

```ts
export { start } from "./start.js";
export type { ExitReport, RunningApp, StartOptions, TeardownError } from "./start.js";
export type { Clock } from "./clock.js";
export { systemClock } from "./clock.js";
export type { DrainReport } from "./drain-report.js";
export type { EventSink, KernelEvent } from "./events.js";
export { stderrSink } from "./events.js";
export type { Phase } from "./phase.js";
export { RuntimeStartFailed } from "./runtime.js";
export type { RunUnit, Runtime, RuntimeHost, Serving } from "./runtime.js";
export { currentUnit } from "./ambient.js";
export type { UnitRecord } from "./ambient.js";
export type { UnitMeta, UnitRegistry, UnitWork } from "./units.js";
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm --filter @btravstack/start test -- start`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/start/src/start.ts packages/start/src/deferred.ts \
        packages/start/src/start.spec.ts packages/start/src/index.ts \
        packages/start/src/test-runtime.ts
git commit -m "feat: boot a module into a running application"
```

---

### Task 8: Draining

**Files:**
- Modify: `packages/start/src/start.ts`
- Create: `packages/start/src/drain.ts`
- Test: `packages/start/src/drain.spec.ts`

**Interfaces:**
- Consumes: `Clock` (Task 3), `UnitRegistry` (Task 5), `Serving` (Task 6), `DrainReport` (Task 2).
- Produces: `drainApp(args): AsyncResult<DrainReport, never>` where `args = { serving: Serving; registry: UnitRegistry; clock: Clock; preDrainDelayMs: number; drainTimeoutMs: number; skip: AbortSignal; onReadyChange: (ready: boolean) => void }`.

Defaults, fixed here: `preDrainDelayMs = 5_000`, `drainTimeoutMs = 20_000`.

- [ ] **Step 1: Write the failing test**

`packages/start/src/drain.spec.ts`:

```ts
import { Ok } from "unthrown";
import { describe, expect, it, vi } from "vitest";

import type { Clock } from "./clock.js";
import { drainApp } from "./drain.js";
import { createUnitRegistry } from "./units.js";

const immediateClock: Clock = { now: () => 0, sleep: () => Promise.resolve() };

const servingStub = () => {
  const calls: string[] = [];
  return {
    calls,
    serving: {
      drain: () => {
        calls.push("drain");
        return Ok({ inFlightAtStart: 0, completed: 0, abandoned: 0 }).toAsync();
      },
      stop: () => {
        calls.push("stop");
        return Ok(undefined).toAsync();
      },
    },
  };
};

describe("drainApp", () => {
  it("flips readiness false before telling the runtime to stop accepting", async () => {
    const order: string[] = [];
    const { serving } = servingStub();

    await drainApp({
      serving: {
        drain: () => {
          order.push("stopAccepting");
          return Ok({ inFlightAtStart: 0, completed: 0, abandoned: 0 }).toAsync();
        },
        stop: serving.stop,
      },
      registry: createUnitRegistry(),
      clock: immediateClock,
      preDrainDelayMs: 5_000,
      drainTimeoutMs: 20_000,
      skip: new AbortController().signal,
      onReadyChange: (ready) => order.push(`ready:${ready}`),
    });

    expect(order).toEqual(["ready:false", "stopAccepting"]);
  });

  it("waits preDrainDelayMs before stopping acceptance", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { serving } = servingStub();

    await drainApp({
      serving,
      registry: createUnitRegistry(),
      clock: { now: () => 0, sleep },
      preDrainDelayMs: 5_000,
      drainTimeoutMs: 20_000,
      skip: new AbortController().signal,
      onReadyChange: () => {},
    });

    expect(sleep).toHaveBeenCalledWith(5_000, expect.any(AbortSignal));
  });

  it("counts a unit still open at the deadline as abandoned", async () => {
    const registry = createUnitRegistry();
    const { serving } = servingStub();
    let aborted = false;

    void registry.run({ kind: "t", id: "1" }, async (signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      await new Promise(() => {});
      return Ok("never");
    });

    const report = await drainApp({
      serving,
      registry,
      clock: immediateClock,
      preDrainDelayMs: 0,
      drainTimeoutMs: 0,
      skip: new AbortController().signal,
      onReadyChange: () => {},
    });

    expect(report).toBeOkWith({ inFlightAtStart: 1, completed: 0, abandoned: 1 });
    expect(aborted).toBe(true);
  });

  it("reports every unit completed when they settle before the deadline", async () => {
    const registry = createUnitRegistry();
    const { serving } = servingStub();
    const running = registry.run({ kind: "t", id: "1" }, () => Ok("done").toAsync());
    await running;

    const report = await drainApp({
      serving,
      registry,
      clock: immediateClock,
      preDrainDelayMs: 0,
      drainTimeoutMs: 0,
      skip: new AbortController().signal,
      onReadyChange: () => {},
    });

    expect(report).toBeOkWith({ inFlightAtStart: 0, completed: 0, abandoned: 0 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @btravstack/start test -- drain`
Expected: FAIL — `Failed to resolve import "./drain.js"`.

- [ ] **Step 3: Implement `drain.ts`**

```ts
import { Ok, fromSafePromise, type AsyncResult } from "unthrown";

import type { Clock } from "./clock.js";
import type { DrainReport } from "./drain-report.js";
import type { Serving } from "./runtime.js";
import type { UnitRegistry } from "./units.js";

export type DrainArgs = {
  readonly serving: Serving;
  readonly registry: UnitRegistry;
  readonly clock: Clock;
  readonly preDrainDelayMs: number;
  readonly drainTimeoutMs: number;
  readonly skip: AbortSignal;
  readonly onReadyChange: (ready: boolean) => void;
};

export const drainApp = (args: DrainArgs): AsyncResult<DrainReport, never> => {
  args.onReadyChange(false);

  const deadline = new AbortController();

  return fromSafePromise(
    (async (): Promise<DrainReport> => {
      // Beat 1→2: readiness is already false; give the load balancer time to
      // notice before the runtime starts refusing. A second signal (`skip`)
      // cuts this short.
      await args.clock.sleep(args.preDrainDelayMs, args.skip);

      const inFlightAtStart = args.registry.inFlight();
      await args.serving.drain(deadline.signal);

      // Beat 3: in-flight work runs until the deadline, then is aborted.
      await Promise.race([
        args.registry.awaitIdle(),
        args.clock.sleep(args.drainTimeoutMs, args.skip),
      ]);

      const abandoned = args.registry.inFlight();
      if (abandoned > 0) {
        deadline.abort();
        args.registry.abortAll();
      }

      return { inFlightAtStart, completed: inFlightAtStart - abandoned, abandoned };
    })(),
  ).flatMap((report) => Ok(report));
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @btravstack/start test -- drain`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire `drainApp` into `start.ts`**

Replace `finish`'s body so a `signal` reason drains first and a `runtimeStopped` reason does not:

```ts
const finish = (
  serving: Serving,
  reason: ExitReport["reason"],
  ctx: FinishContext,
): AsyncResult<ExitReport, never> => {
  const drained =
    reason === "signal"
      ? (ctx.tracker.advanceTo("draining"),
        ctx.emit({ type: "draining", inFlight: ctx.registry.inFlight() }),
        drainApp({
          serving,
          registry: ctx.registry,
          clock: ctx.clock,
          preDrainDelayMs: ctx.preDrainDelayMs,
          drainTimeoutMs: ctx.drainTimeoutMs,
          skip: ctx.skipDrain.signal,
          onReadyChange: ctx.onReadyChange,
        }).tap((report) => ctx.emit({ type: "drained", report })))
      : Ok(undefined).toAsync();

  return drained.flatMap((report) => {
    ctx.tracker.advanceTo("stopping");
    return serving.stop().map(() => {
      ctx.tracker.advanceTo("exited");
      return {
        reason,
        drain: report,
        teardownErrors: ctx.teardownErrors,
        uptimeMs: ctx.clock.now() - ctx.startedAt,
      };
    });
  });
};
```

`FinishContext` is a `type` holding the fields the previous positional parameters carried, plus `emit`, `preDrainDelayMs`, `drainTimeoutMs`, `skipDrain: AbortController` and `onReadyChange`.

- [ ] **Step 6: Run the whole suite**

Run: `pnpm --filter @btravstack/start test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/start/src/drain.ts packages/start/src/drain.spec.ts packages/start/src/start.ts
git commit -m "feat: drain in-flight work before stopping"
```

---

### Task 9: Signal handling

**Files:**
- Create: `packages/start/src/signals.ts`
- Modify: `packages/start/src/start.ts`
- Test: `packages/start/src/signals.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `installSignalHandlers(args: { onFirst: () => void; onSecond: () => void }): () => void` — returns a disposer that removes every listener it added.

- [ ] **Step 1: Write the failing test**

`packages/start/src/signals.spec.ts`:

```ts
import { describe, expect, it } from "vitest";

import { installSignalHandlers } from "./signals.js";

const listenerCount = (): number =>
  process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");

describe("installSignalHandlers", () => {
  it("calls onFirst for the first signal and onSecond for the next", () => {
    const seen: string[] = [];
    const dispose = installSignalHandlers({
      onFirst: () => seen.push("first"),
      onSecond: () => seen.push("second"),
    });

    process.emit("SIGTERM");
    process.emit("SIGTERM");
    process.emit("SIGINT");

    expect(seen).toEqual(["first", "second", "second"]);
    dispose();
  });

  it("removes every listener it added", () => {
    const before = listenerCount();
    const dispose = installSignalHandlers({ onFirst: () => {}, onSecond: () => {} });

    expect(listenerCount()).toBe(before + 2);
    dispose();
    expect(listenerCount()).toBe(before);
  });
});
```

The second test is the invariant that lets a Vitest file boot many applications without leaking handlers into each other.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @btravstack/start test -- signals`
Expected: FAIL — `Failed to resolve import "./signals.js"`.

- [ ] **Step 3: Implement `signals.ts`**

```ts
const SIGNALS = ["SIGTERM", "SIGINT"] as const;

export type SignalHandlers = {
  readonly onFirst: () => void;
  readonly onSecond: () => void;
};

export const installSignalHandlers = (handlers: SignalHandlers): (() => void) => {
  let seen = 0;

  const onSignal = (): void => {
    seen += 1;
    if (seen === 1) {
      handlers.onFirst();
      return;
    }
    handlers.onSecond();
  };

  for (const signal of SIGNALS) process.on(signal, onSignal);

  return () => {
    for (const signal of SIGNALS) process.off(signal, onSignal);
  };
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @btravstack/start test -- signals`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire into `start.ts`**

Inside `start`, after the phase tracker is created and only when `options.signals !== false`:

```ts
const skipDrain = new AbortController();
const disposeSignals =
  options.signals === false
    ? () => {}
    : installSignalHandlers({
        onFirst: () => shutdown.resolve("signal"),
        onSecond: () => skipDrain.abort(),
      });
```

and call `disposeSignals()` inside `finish`, immediately before `tracker.advanceTo("exited")`, so the listeners are gone before the result settles.

- [ ] **Step 6: Add the end-to-end test to `start.spec.ts`**

```ts
it("drains on SIGTERM and skips the drain on a second signal", async () => {
  const runtime = testRuntime();
  const app = start(AppModule, {
    runtime,
    probes: false,
    preDrainDelayMs: 60_000,
    drainTimeoutMs: 60_000,
  });
  await runtime.untilStarted();

  process.emit("SIGTERM");
  await Promise.resolve();
  expect(app.phase()).toBe("draining");

  process.emit("SIGTERM");

  const report = await app.exited;
  expect(report).toBeOkWith(expect.objectContaining({ reason: "signal" }));
});
```

Without the second signal aborting the `preDrainDelayMs` sleep, this test would take sixty seconds — which is the behaviour being asserted.

- [ ] **Step 7: Run the whole suite**

Run: `pnpm --filter @btravstack/start test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/start/src/signals.ts packages/start/src/signals.spec.ts \
        packages/start/src/start.ts packages/start/src/start.spec.ts
git commit -m "feat: drain on SIGTERM and skip the drain on a second signal"
```

---

### Task 10: Uncaught exceptions and unhandled rejections

**Files:**
- Create: `packages/start/src/uncaught.ts`
- Modify: `packages/start/src/start.ts`
- Test: `packages/start/src/uncaught.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `installUncaughtHandlers(onUncaught: (cause: unknown) => void): () => void`.

- [ ] **Step 1: Write the failing test**

`packages/start/src/uncaught.spec.ts`:

```ts
import { describe, expect, it } from "vitest";

import { installUncaughtHandlers } from "./uncaught.js";

describe("installUncaughtHandlers", () => {
  it("reports an uncaught exception once", () => {
    const seen: unknown[] = [];
    const dispose = installUncaughtHandlers((cause) => seen.push(cause));
    const error = new Error("boom");

    process.emit("uncaughtException", error);
    process.emit("uncaughtException", new Error("second"));

    expect(seen).toEqual([error]);
    dispose();
  });

  it("reports an unhandled rejection", () => {
    const seen: unknown[] = [];
    const dispose = installUncaughtHandlers((cause) => seen.push(cause));

    process.emit("unhandledRejection", "reason", Promise.resolve());

    expect(seen).toEqual(["reason"]);
    dispose();
  });

  it("removes every listener it added", () => {
    const before =
      process.listenerCount("uncaughtException") + process.listenerCount("unhandledRejection");
    const dispose = installUncaughtHandlers(() => {});

    expect(
      process.listenerCount("uncaughtException") + process.listenerCount("unhandledRejection"),
    ).toBe(before + 2);
    dispose();
    expect(
      process.listenerCount("uncaughtException") + process.listenerCount("unhandledRejection"),
    ).toBe(before);
  });
});
```

Reporting only the **first** matters: the shutdown it triggers may itself produce further noise, and the exit report names one cause.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @btravstack/start test -- uncaught`
Expected: FAIL — `Failed to resolve import "./uncaught.js"`.

- [ ] **Step 3: Implement `uncaught.ts`**

```ts
export const installUncaughtHandlers = (onUncaught: (cause: unknown) => void): (() => void) => {
  let reported = false;

  const report = (cause: unknown): void => {
    if (reported) return;
    reported = true;
    onUncaught(cause);
  };

  const onException = (error: Error): void => report(error);
  const onRejection = (reason: unknown): void => report(reason);

  process.on("uncaughtException", onException);
  process.on("unhandledRejection", onRejection);

  return () => {
    process.off("uncaughtException", onException);
    process.off("unhandledRejection", onRejection);
  };
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @btravstack/start test -- uncaught`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into `start.ts`**

Installed under the same `options.signals !== false` guard (a test harness driving transitions directly must not have process handlers installed):

```ts
const disposeUncaught =
  options.signals === false
    ? () => {}
    : installUncaughtHandlers((cause) => {
        emit({ type: "uncaught", cause });
        onReadyChange(false);
        skipDrain.abort();
        shutdown.resolve("uncaught");
      });
```

`finish` already skips the drain for any reason other than `"signal"`, so `"uncaught"` goes straight to `stopping` — the harsher path the spec requires. Call `disposeUncaught()` alongside `disposeSignals()`.

- [ ] **Step 6: Add the end-to-end test to `start.spec.ts`**

```ts
it("skips the drain and marks itself unready on an uncaught exception", async () => {
  const runtime = testRuntime();
  const app = start(AppModule, { runtime, probes: false, preDrainDelayMs: 60_000 });
  await runtime.untilStarted();

  process.emit("uncaughtException", new Error("boom"));

  const report = await app.exited;
  expect(report).toBeOkWith(
    expect.objectContaining({ reason: "uncaught", drain: undefined }),
  );
});
```

- [ ] **Step 7: Run the whole suite and commit**

Run: `pnpm --filter @btravstack/start test`

```bash
git add packages/start/src/uncaught.ts packages/start/src/uncaught.spec.ts \
        packages/start/src/start.ts packages/start/src/start.spec.ts
git commit -m "feat: stop hard on an uncaught exception"
```

---

### Task 11: The probe server

**Files:**
- Create: `packages/start/src/probes.ts`
- Modify: `packages/start/src/start.ts`
- Test: `packages/start/src/probes.spec.ts`

**Interfaces:**
- Consumes: `Phase` (Task 2).
- Produces: `startProbeServer(args: { port: number; live: () => boolean; ready: () => boolean }): AsyncResult<ProbeServer, RuntimeStartFailed>` where `ProbeServer = { port: number; close: () => Promise<void> }`.

Routes: `GET /livez` → 200 `ok` when `live()`, else 503. `GET /readyz` → 200 `ready` when `ready()`, else 503. Anything else → 404. This answers the spec's third open question by **not** adding a startup probe: `/livez` is true from `building` onward, so a slow graph is covered by `/readyz` alone.

- [ ] **Step 1: Write the failing test**

`packages/start/src/probes.spec.ts`:

```ts
import { describe, expect, it } from "vitest";

import { startProbeServer } from "./probes.js";

const get = async (port: number, path: string): Promise<{ status: number; body: string }> => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, body: await response.text() };
};

describe("startProbeServer", () => {
  it("serves liveness and readiness from the supplied predicates", async () => {
    let ready = false;
    const started = await startProbeServer({ port: 0, live: () => true, ready: () => ready });
    const server = started.getOrThrow();

    expect(await get(server.port, "/livez")).toEqual({ status: 200, body: "ok" });
    expect((await get(server.port, "/readyz")).status).toBe(503);

    ready = true;
    expect(await get(server.port, "/readyz")).toEqual({ status: 200, body: "ready" });

    await server.close();
  });

  it("404s an unknown path", async () => {
    const started = await startProbeServer({ port: 0, live: () => true, ready: () => true });
    const server = started.getOrThrow();

    expect((await get(server.port, "/nope")).status).toBe(404);

    await server.close();
  });

  it("reports a port it cannot bind", async () => {
    const first = (
      await startProbeServer({ port: 0, live: () => true, ready: () => true })
    ).getOrThrow();

    const second = await startProbeServer({
      port: first.port,
      live: () => true,
      ready: () => true,
    });

    expect(second).toBeErrTagged("RuntimeStartFailed", { runtime: "probes" });
    await first.close();
  });
});
```

`port: 0` asks the OS for a free port, which is what makes these tests safe to run in parallel; `server.port` reports the one actually bound.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @btravstack/start test -- probes`
Expected: FAIL — `Failed to resolve import "./probes.js"`.

- [ ] **Step 3: Implement `probes.ts`**

```ts
import { createServer, type Server } from "node:http";
import { Err, Ok, fromSafePromise, type AsyncResult } from "unthrown";

import { RuntimeStartFailed } from "./runtime.js";

export type ProbeServer = {
  readonly port: number;
  readonly close: () => Promise<void>;
};

export type ProbeArgs = {
  readonly port: number;
  readonly live: () => boolean;
  readonly ready: () => boolean;
};

export const startProbeServer = (args: ProbeArgs): AsyncResult<ProbeServer, RuntimeStartFailed> =>
  fromSafePromise(
    new Promise<Result<ProbeServer, RuntimeStartFailed>>((resolve) => {
      const server: Server = createServer((request, response) => {
        const path = request.url ?? "";
        if (path === "/livez") {
          respond(response, args.live(), "ok");
          return;
        }
        if (path === "/readyz") {
          respond(response, args.ready(), "ready");
          return;
        }
        response.writeHead(404).end();
      });

      server.once("error", (cause) => {
        resolve(Err(new RuntimeStartFailed({ runtime: "probes", cause })));
      });

      server.listen(args.port, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : args.port;
        resolve(
          Ok({
            port,
            close: () => new Promise<void>((done) => server.close(() => done())),
          }),
        );
      });

      server.unref();
    }),
  ).flatMap((result) => result);

const respond = (
  response: { writeHead: (status: number) => { end: (body?: string) => void } },
  healthy: boolean,
  body: string,
): void => {
  if (healthy) {
    response.writeHead(200).end(body);
    return;
  }
  response.writeHead(503).end("unavailable");
};
```

Import `Result` as a type from `unthrown` alongside the values.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @btravstack/start test -- probes`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into `start.ts`**

Default `probes` to `{ port: 9000 }`. Start the server **before** `Module.scoped`, so `/livez` answers while the graph is still building; close it in `finish` after `tracker.advanceTo("exited")`. `ready` is `() => tracker.current() === "serving"`, and the `onReadyChange` callback threaded through `drainApp` becomes a no-op override that forces `false` early — model it as a `let ready = false` the tracker and `onReadyChange` both write, read by the probe predicate.

- [ ] **Step 6: Run the whole suite and commit**

Run: `pnpm --filter @btravstack/start test`

```bash
git add packages/start/src/probes.ts packages/start/src/probes.spec.ts packages/start/src/start.ts
git commit -m "feat: serve liveness and readiness probes"
```

---

### Task 12: `runMain`, the testing entry point, and the invariants suite

**Files:**
- Create: `packages/start/src/run-main.ts`, `packages/start/src/testing.ts`, `packages/start/src/with-app.ts`, `packages/start/src/fake-clock.ts`
- Modify: `packages/start/src/index.ts`, `packages/start/package.json` (restore `src/testing.ts` in the build scripts)
- Test: `packages/start/src/run-main.spec.ts`, `packages/start/src/invariants.spec.ts`

**Interfaces:**
- Consumes: `RunningApp`, `ExitReport` (Task 7); everything above.
- Produces:
  - `runMain<E>(app: RunningApp<E>, exit?: (code: number) => void): Promise<void>`
  - `createFakeClock(): Clock & { advance: (ms: number) => Promise<void> }`
  - `withApp<X, E, Needs, A>(module, options, use: (app: RunningApp<E>) => Promise<A>): Promise<A>`
  - `@btravstack/start/testing` exporting `testRuntime`, `createFakeClock`, `withApp`

- [ ] **Step 1: Write the failing `runMain` test**

`packages/start/src/run-main.spec.ts`:

```ts
import { Err, Ok } from "unthrown";
import { describe, expect, it } from "vitest";

import { runMain } from "./run-main.js";

const appWith = (exited: unknown) =>
  ({ exited, stop: () => {}, phase: () => "exited" }) as never;

describe("runMain", () => {
  it("exits 0 on a clean report", async () => {
    const codes: number[] = [];
    await runMain(
      appWith(Ok({ reason: "signal", drain: undefined, teardownErrors: [], uptimeMs: 1 }).toAsync()),
      (code) => codes.push(code),
    );
    expect(codes).toEqual([0]);
  });

  it("exits 2 when work was abandoned", async () => {
    const codes: number[] = [];
    await runMain(
      appWith(
        Ok({
          reason: "signal",
          drain: { inFlightAtStart: 3, completed: 1, abandoned: 2 },
          teardownErrors: [],
          uptimeMs: 1,
        }).toAsync(),
      ),
      (code) => codes.push(code),
    );
    expect(codes).toEqual([2]);
  });

  it("exits 1 on a startup failure", async () => {
    const codes: number[] = [];
    await runMain(appWith(Err("no-config").toAsync()), (code) => codes.push(code));
    expect(codes).toEqual([1]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @btravstack/start test -- run-main`
Expected: FAIL — `Failed to resolve import "./run-main.js"`.

- [ ] **Step 3: Implement `run-main.ts`**

```ts
import { P } from "unthrown";

import type { ExitReport, RunningApp } from "./start.js";

const codeFor = (report: ExitReport): number =>
  (report.drain?.abandoned ?? 0) > 0 ? 2 : 0;

export const runMain = async <E>(
  app: RunningApp<E>,
  exit: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): Promise<void> => {
  const result = await app.exited;

  exit(
    result.match({
      ok: codeFor,
      // The single sanctioned place this package decides a process's fate. `E`
      // is the application's own error type, unresolved here, so the catch-all
      // is the only arm that can terminate the match — the generic-`E` case
      // Thesis #5 keeps `P._` for.
      // oxlint-disable-next-line unthrown/no-catch-all-pattern
      errCases: (matcher) => matcher.with(P._, () => 1),
      defect: () => 70,
    }),
  );
};
```

`result.match` is the method form, so only `P` is imported.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @btravstack/start test -- run-main`
Expected: PASS (3 tests).

- [ ] **Step 5: Implement `fake-clock.ts`**

```ts
import type { Clock } from "./clock.js";

type Sleeper = { readonly due: number; readonly resolve: () => void; readonly signal?: AbortSignal };

export type FakeClock = Clock & { readonly advance: (ms: number) => Promise<void> };

export const createFakeClock = (start = 0): FakeClock => {
  let now = start;
  let sleepers: Sleeper[] = [];

  return {
    now: () => now,
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        if (ms <= 0 || signal?.aborted === true) {
          resolve();
          return;
        }
        const sleeper: Sleeper = { due: now + ms, resolve, signal };
        sleepers.push(sleeper);
        signal?.addEventListener(
          "abort",
          () => {
            sleepers = sleepers.filter((s) => s !== sleeper);
            resolve();
          },
          { once: true },
        );
      }),
    advance: async (ms) => {
      now += ms;
      const due = sleepers.filter((s) => s.due <= now);
      sleepers = sleepers.filter((s) => s.due > now);
      for (const sleeper of due) sleeper.resolve();
      await Promise.resolve();
    },
  };
};
```

- [ ] **Step 6: Implement `with-app.ts` and `testing.ts`**

`with-app.ts`:

```ts
import type { AnyPort, Module } from "@btravstack/di";

import { start, type RunningApp, type StartOptions } from "./start.js";

export const withApp = async <X extends AnyPort, E, Needs extends AnyPort, A>(
  module: Module<X, E, never>,
  options: StartOptions<Needs>,
  use: (app: RunningApp<E>) => Promise<A>,
): Promise<A> => {
  // A harness always drives transitions directly: process handlers would fight
  // across a test file, and a probe port would collide between tests.
  const app = start(module, { ...options, signals: false, probes: false });

  try {
    return await use(app);
  } finally {
    app.stop();
    await app.exited;
  }
};
```

`testing.ts`:

```ts
export { createFakeClock, type FakeClock } from "./fake-clock.js";
export { testRuntime, type SubmittedUnit, type TestRuntime } from "./test-runtime.js";
export { withApp } from "./with-app.js";
```

Restore `src/testing.ts` in `packages/start/package.json`'s `build` and `dev` scripts.

- [ ] **Step 7: Write the invariants suite**

`packages/start/src/invariants.spec.ts` — one `it` per numbered invariant in the spec, each named after it:

```ts
import { Module, Port, Provider } from "@btravstack/di";
import { Ok } from "unthrown";
import { describe, expect, it } from "vitest";

import { createFakeClock } from "./fake-clock.js";
import { start } from "./start.js";
import { testRuntime } from "./test-runtime.js";
import { withApp } from "./with-app.js";

class Greeting extends Port("Greeting")<{ readonly text: string }> {}
const AppModule = Module("App")({
  provides: [Provider(Greeting)({ value: { text: "hello" } })],
  exports: [Greeting],
});

describe("load-bearing invariants", () => {
  it("1. readiness is false before the runtime stops accepting", async () => {
    const clock = createFakeClock();
    const runtime = testRuntime();
    const order: string[] = [];

    await withApp(AppModule, { runtime, clock, onEvent: () => {} }, async (app) => {
      await runtime.untilStarted();
      runtime.onStopAccepting(() => order.push("stopAccepting"));
      app.requestDrain();
      await Promise.resolve();
      order.push(`ready:${app.ready()}`);
      await clock.advance(5_000);
      await app.exited;
    });

    expect(order[0]).toBe("ready:false");
    expect(order[1]).toBe("stopAccepting");
  });

  it("2. in-flight units complete when the drain has time for them", async () => {
    const clock = createFakeClock();
    const runtime = testRuntime();

    const report = await withApp(AppModule, { runtime, clock, onEvent: () => {} }, async (app) => {
      await runtime.untilStarted();
      const unit = runtime.submit<string>();
      app.requestDrain();
      await clock.advance(5_000);
      unit.settle(Ok("done"));
      await unit.result;
      await clock.advance(20_000);
      return app.exited;
    });

    expect(report).toBeOkWith(
      expect.objectContaining({ drain: { inFlightAtStart: 1, completed: 1, abandoned: 0 } }),
    );
  });

  it("3. units still open at the deadline are counted as abandoned", async () => {
    const clock = createFakeClock();
    const runtime = testRuntime();

    const report = await withApp(AppModule, { runtime, clock, onEvent: () => {} }, async (app) => {
      await runtime.untilStarted();
      runtime.submit<string>();
      app.requestDrain();
      await clock.advance(5_000);
      await clock.advance(20_000);
      return app.exited;
    });

    expect(report).toBeOkWith(
      expect.objectContaining({ drain: { inFlightAtStart: 1, completed: 0, abandoned: 1 } }),
    );
  });

  it("4. the unit AbortSignal fires at the drain deadline", async () => {
    const clock = createFakeClock();
    const runtime = testRuntime();
    let aborted = false;

    await withApp(AppModule, { runtime, clock, onEvent: () => {} }, async (app) => {
      await runtime.untilStarted();
      const unit = runtime.submit<string>();
      unit.signal.addEventListener("abort", () => {
        aborted = true;
      });
      app.requestDrain();
      await clock.advance(25_000);
      await app.exited;
    });

    expect(aborted).toBe(true);
  });

  it("5. the application scope closes on a startup failure", async () => {
    const released: string[] = [];
    const Half = Module("Half")({
      provides: [
        Provider(Greeting)({
          acquire: () => Ok({ text: "hi" }).toAsync(),
          release: () => {
            released.push("greeting");
          },
        }),
      ],
      exports: [Greeting],
    });
    const broken = {
      ...testRuntime(),
      start: () =>
        Err(new RuntimeStartFailed({ runtime: "broken", cause: "nope" })).toAsync(),
    };

    await start(Half, { runtime: broken, signals: false, probes: false, onEvent: () => {} })
      .exited;

    expect(released).toEqual(["greeting"]);
  });

  it("8. start neither throws nor calls process.exit", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const runtime = testRuntime();

    await withApp(AppModule, { runtime, onEvent: () => {} }, async (app) => {
      await runtime.untilStarted();
      return app.exited;
    });

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("9. signal listeners are removed on exit", async () => {
    const before = process.listenerCount("SIGTERM");
    const runtime = testRuntime();
    const app = start(AppModule, { runtime, probes: false, onEvent: () => {} });
    await runtime.untilStarted();
    app.stop();
    await app.exited;

    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});
```

Invariants 6 (second signal skips the drain) and 7 (teardown errors never mask the exit reason) are already covered by `start.spec.ts` — add a comment in this file pointing at the covering test rather than duplicating it.

This step requires three additions to earlier files, all small:
- `RunningApp` gains `requestDrain: () => void` (resolves the shutdown deferred with `"signal"`) and `ready: () => boolean`.
- `testRuntime` gains `untilStarted(): Promise<void>` and `onStopAccepting(fn: () => void): void`.
- Import `Err`, `vi` and `RuntimeStartFailed` where used.

- [ ] **Step 8: Run the whole suite with coverage**

Run: `pnpm --filter @btravstack/start test -- --coverage`
Expected: PASS; 100% lines and functions (thresholds set in Task 1).

- [ ] **Step 9: Commit**

```bash
git add packages/start/src packages/start/package.json
git commit -m "feat: add runMain, the testing entry point, and the invariants suite"
```

---

### Task 13: Documentation and the first changeset

**Files:**
- Create: `README.md`, `CLAUDE.md`, `packages/start/README.md`, `LICENSE`, `packages/start/LICENSE`, `.changeset/initial-kernel.md`
- Modify: `docs/superpowers/specs/2026-08-09-btravstack-start-design.md` (record the two deviations and close the three open questions)

**Interfaces:**
- Consumes: the finished public surface.
- Produces: nothing code depends on.

- [ ] **Step 1: Write `CLAUDE.md`**

Follow the house shape used by `unthrown` and `di`: a Thesis section (one process one runtime; ambient carries data, `Context` carries capabilities; the kernel never maps outcomes to transports; `start` never exits the process), a **Load-bearing runtime invariants** section listing the nine invariants with the test that guards each, a **Public surface** section, an **Internal design** section (why `Context`'s contravariance gives the needs check for free; why `finish` skips the drain for every reason but `"signal"`), and a **Toolchain** section copied from the Global Constraints above.

- [ ] **Step 2: Write the READMEs**

Root `README.md`: what the kernel is, the NestJS comparison table from the spec, a worked example ending in `runMain`, and the runtime-package map. `packages/start/README.md`: install, the same worked example, a link to the repo.

Copy `LICENSE` (MIT, `Benoit TRAVERS`) to both the root and `packages/start/`.

- [ ] **Step 3: Verify the README example compiles**

Add `packages/start/src/docs-examples.test-d.ts` holding every sample the READMEs ship, following `@unthrown/drizzle`'s pattern. Run: `pnpm --filter @btravstack/start test:types`
Expected: PASS.

- [ ] **Step 4: Write the changeset**

`.changeset/initial-kernel.md`:

```md
---
"@btravstack/start": minor
---

The application kernel: `start` boots a `@btravstack/di` module into a running process with one runtime, drains in-flight work on SIGTERM, and closes the application scope on every path. Ships `runMain`, liveness/readiness probes, and a `@btravstack/start/testing` entry point with `testRuntime`, `createFakeClock` and `withApp`.
```

- [ ] **Step 5: Update the spec**

Record the two deviations from the "Deviations from the spec" section above as decisions, and close the three open questions: `unit` takes a module (not a factory — deferred until a runtime needs it); `Deadline` is an `AbortSignal` handed to `Serving.drain`; no separate startup probe, `/readyz` covers a slow build.

- [ ] **Step 6: Run the full gate**

Run:

```bash
pnpm format --check && pnpm lint && pnpm typecheck && pnpm knip && pnpm test && pnpm build
```

Expected: all six pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs: document the kernel and add the first changeset"
```

---

## Deferred to a later plan

- `@btravstack/start-http`, `-amqp`, `-temporal` — the runtime implementations. The `Runtime` contract is the whole of what this plan owes them.
- The `@btravstack/oxlint` rule banning `currentUnit()` outside infrastructure adapters. It needs a way to identify an adapter, which is a convention this repo has not yet established.
- Per-unit ports (the `unit` module wired into `run`'s fork). `RunUnit` is typed for it, and Task 7's `run` passes the application `ctx` straight through; the `Module.forkScope` call lands when the first runtime needs a per-request transaction.
