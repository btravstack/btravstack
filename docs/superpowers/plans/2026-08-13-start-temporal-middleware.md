# `@btravstack/start-temporal` — middleware integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Supersedes:** `docs/superpowers/plans/2026-08-12-start-temporal.md`. That plan's Tasks 1–3 are **done and reviewed clean** (`5e90b29`, `ea987e8`, `5710164`); its Tasks 4–9 described a two-integration package and no longer apply. Do not work from it.

**Goal:** Finish `@btravstack/start-temporal` as a **`temporal-contract`-only** runtime — one kernel unit per activity attempt through an `ActivityMiddleware`, and a drain that releases the kernel at its own deadline rather than Temporal's.

**Architecture:** A factory owns `Worker.create` and adapts it to `Serving`. Activities are built from the host — `activities: (host) => declareActivitiesHandler({ contract, middleware: [activityUnits(host)], … })` — so the middleware opens the unit and injects the DI context through `temporal-contract`'s own per-invocation channel. The package never wraps activities itself.

**Tech Stack:** TypeScript (ESM-first, `NodeNext`), `@temporalio/worker` / `@temporalio/activity` / `@temporalio/common` as peers, `@temporalio/testing`'s time-skipping server and `@temporal-contract/worker` as dev-only, vitest + `@unthrown/vitest`, tsdown, oxlint + oxfmt.

**Spec:** `docs/superpowers/specs/2026-08-12-start-temporal-design.md` (revised 2026-08-13)

## Where the branch actually is

Branch `docs/start-temporal-design`, 11 commits, nothing pushed.

| State                                                   | Detail                                                                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Done, reviewed                                          | Scaffold; a worker that starts, publishes `{ taskQueue, namespace }`, stops; a modeled start failure        |
| Done, **never reviewed**, and **to be partly reverted** | `b0451b6` + `daa0344`: `asActivities`, `ActivityImpl`, the activity-boundary `Result` unwrap, and `metaFor` |
| Not started                                             | The middleware, drain tests, the deadline race, coverage gate, README, docs, changeset                      |

`metaFor` survives the revert; everything else in those two commits goes.

## Global Constraints

- **No runtime dependencies.** Peers: `@temporalio/worker`, `@temporalio/activity`, `@temporalio/common`, `@btravstack/start`, `@btravstack/di`, `unthrown`.
- **`temporal-contract` is a devDependency, never a peer.** `ActivityMiddleware` is declared **structurally in our own source**, not imported, so a consumer never inherits it.
- **`knip` must pass with no ignore entries.** An unused dependency is removed, never suppressed. Add a dependency in the task whose code imports it.
- **`engines: { node: ">=20" }`.** No `Promise.withResolvers`.
- TypeScript `strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`. **Relative imports carry `.js`.**
- oxlint binding: no `interface` (use `type`), no `any` (use `unknown`), every `@unthrown/oxlint` rule including `no-throw`. Exceptions carry a targeted `oxlint-disable-next-line` **with a reason**.
- **No `Result` may be produced and left unexamined.**
- **Comment density: sparse** — except where a comment guards a specific line against a plausible "simplification".
- **All five test conventions bind** in test bodies: `describe` first after imports with nothing between; helpers are vitest fixtures in `src/test-fixtures.ts` exporting the extended `it`; teardown in the fixture (a `try`/`finally` **is** allowed in fixture teardown, and is required so `env.teardown()` always runs); `// GIVEN`/`// WHEN`/`// THEN`; **one deep `expect` per test**, never an assertion that can decline to run.
- **Coverage: 100% lines and functions, enabled in Task 5** — not before.
- The gate must stay green: `pnpm format --check`, `pnpm lint`, `pnpm typecheck`, `pnpm knip`, `pnpm test`, `pnpm build`.
- Conventional Commits. Publishable, so it needs a changeset.
- **A new commit per task — never `git commit --amend`.** The branch is shared with a coordinating session.

> **Known local failure, not yours:** `packages/start`'s `invariants.spec.ts` → _"binds 9000 when no probe port is given"_ fails because a proxy holds `127.0.0.1:9000`. It passes in CI. One line in your report; do not investigate.

> **The suite needs the network on a cold cache** — a 64 MB time-skipping server, cached at `<repo>/.cache/temporal-test-server` with `ttl: "365d"`. A cold run takes about a minute; that is not a hang.

> **`workflowsPath` must point at the `.ts` source.** Temporal's bundler `statSync`s the entrypoint with no extension aliasing, then compiles TypeScript itself. This was established the hard way in the prior plan.

---

### Task 1: Revert the raw path

**Files:** Modify `src/activity-units.ts`, `src/index.ts`, `src/test-fixtures.ts`, `src/temporal-runtime.spec.ts`

**Interfaces:** Consumes nothing. Produces `metaFor` (module-private, unchanged) and a package with no `asActivities`.

There is no TDD cycle here — this is a deletion. Its verification is that the remaining suite still passes and the gate is green.

- [ ] **Step 1: Delete `asActivities`, `ActivityImpl` and the boundary helper**

From `src/activity-units.ts`, remove `asActivities`, the `ActivityImpl` type, and the `raise` helper with its `unthrown/no-throw` disable. **Keep `metaFor` exactly as it is** — the middleware needs it and its task-token reasoning is already correct. Remove the `P` import from `unthrown` if nothing else uses it.

From `src/index.ts`, remove the `asActivities` and `ActivityImpl` exports.

- [ ] **Step 2: Remove the tests that only exercised the raw path**

From `src/temporal-runtime.spec.ts`, delete:

- `"hands the workflow the activity's value, not the Result wrapping it"` — it pinned the boundary unwrap, which no longer exists here.
- `"opens one kernel unit per activity attempt"` — Task 2 rewrites it on the middleware.

From `src/test-fixtures.ts`, delete the `recorder` fixture. **Keep the host-proxy technique in mind** — Task 2 rebuilds it, because `currentUnit()` cannot see `UnitMeta.id` and a weaker assertion would test nothing.

- [ ] **Step 3: Narrow `TemporalOptions.activities` to the builder form**

```ts
  readonly activities: (host: RuntimeHost<Needs>) => Record<string, (...args: never[]) => unknown>;
```

The union with a plain `Record` existed for the raw path. `temporalRuntime` calls `options.activities(host)` unconditionally.

- [ ] **Step 4: Run the gate**

```bash
cd packages/start-temporal && pnpm test && pnpm typecheck
cd ../.. && pnpm knip && pnpm lint && pnpm format --check
```

Expected: 2 tests remain (`Serving.info`, and the modeled start failure), both passing. `knip` clean with no ignores. If `@temporalio/activity` is now unimported — `metaFor` should still import it — remove it from `devDependencies` rather than suppressing.

- [ ] **Step 5: Commit**

```bash
git add packages/start-temporal
git commit -m "refactor(start-temporal): drop the raw worker path"
```

---

### Task 2: The middleware, and one unit per attempt

**Files:** Modify `src/activity-units.ts`, `src/index.ts`, `src/test-fixtures.ts`, `src/temporal-runtime.spec.ts`, `package.json`

**Interfaces produced:**

- `ActivityMiddleware<Needs extends AnyPort>` — declared structurally:
  ```ts
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
  ```
- `activityUnits<Needs extends AnyPort>(host: RuntimeHost<Needs>): ActivityMiddleware<Needs>`

- [ ] **Step 0: Remove the transient `knip` entry**

Task 1 added `"packages/start-temporal": { "entry": ["src/activity-units.ts"] }` to `knip.json`, because after the revert nothing imported that file until this task. It declares an entry point that is not one, so **delete it** as soon as `index.ts` exports `activityUnits` — and confirm `knip` still passes with no `packages/start-temporal` key at all. Leaving it would permanently blind `knip` to dead code in that file.

- [ ] **Step 1: Add `@temporal-contract/worker` as a devDependency**

`"@temporal-contract/worker": "catalog:"` — **devDependency only**, keys sorted. It must never reach `peerDependencies`. Then `pnpm install`.

- [ ] **Step 2: Add the `contractSeam` fixture to `src/test-fixtures.ts`**

It needs a minimal contract with one `echo` activity, the middleware in the chain, and a **host proxy** recording the `UnitMeta` — because `currentUnit()` exposes the kernel's `unitId` counter, not `UnitMeta.id`, and asserting `expect.any(String)` would test nothing.

```ts
  readonly contractSeam: {
    readonly build: (host: RuntimeHost<typeof Greeting>) => Record<string, (...args: never[]) => unknown>;
    readonly seen: () => readonly UnitMeta[];
    readonly taskToken: () => string;
    readonly greeting: () => string;
  };
```

The `build` implementation wraps `host` in a recording proxy (`{ ctx: host.ctx, run: (meta, work) => { seen.push(meta); return host.run(meta, work); } }`), passes that proxy to `activityUnits`, and declares the handler:

```ts
declareActivitiesHandler({
  contract,
  middleware: [activityUnits(watched)],
  activities: {
    echo: (args, { context }) => {
      token = activityInfo().base64TaskToken;
      greeting = context.ctx.get(Greeting).text;
      return OkAsync(args.value);
    },
  },
});
```

Adapt the nesting to whatever the contract's shape requires — read `examples/order-temporal/src/contract.ts` and its `temporal-contract` usage for the exact form.

**Also fix the teardown while you are here:** both existing fixtures run `await expect(app.exited)…` _before_ `await env.teardown()`, so a thrown assertion leaks the time-skipping server. Wrap so `env.teardown()` runs regardless — a `try`/`finally` is correct in fixture teardown.

- [ ] **Step 3: Write the two failing tests**

```ts
it("opens one kernel unit per activity attempt", async ({
  serve,
  contractSeam,
}) => {
  // GIVEN activities declared through temporal-contract with the middleware
  const { client, taskQueue } = await serve(contractSeam.build);

  // WHEN a workflow drives one attempt
  await client.workflow.execute("runEcho", {
    taskQueue,
    workflowId: "wf-unit-1",
    args: ["x"],
  });

  // THEN the attempt ran inside a unit whose meta identifies it by Temporal's
  // task token, with the workflow id as the correlation id — `id` must be unique
  // per unit, and a workflow id is not: an activity is retried under the same
  // execution.
  expect(contractSeam.seen()).toEqual([
    { kind: "activity", id: contractSeam.taskToken(), traceId: "wf-unit-1" },
  ]);
});

it("injects the application context through the contract's own channel", async ({
  serve,
  contractSeam,
}) => {
  // GIVEN the same wiring
  const { client, taskQueue } = await serve(contractSeam.build);

  // WHEN a workflow drives one attempt
  await client.workflow.execute("runEcho", {
    taskQueue,
    workflowId: "wf-ctx-1",
    args: ["x"],
  });

  // THEN the implementation reached the DI graph without the package inventing a
  // channel of its own — which is what makes the seam cost one line
  expect(contractSeam.greeting()).toBe("hello");
});
```

- [ ] **Step 4: Run and watch them fail**

Run: `cd packages/start-temporal && pnpm vitest run src/temporal-runtime.spec.ts`
Expected: FAIL — `activityUnits` does not exist. Record the output.

- [ ] **Step 5: Implement `activityUnits`**

```ts
/**
 * The shape of `temporal-contract`'s `ActivityMiddleware`, declared here rather
 * than imported. Structural typing makes the two compatible, and it keeps
 * `temporal-contract` out of this package's peer range — a consumer who does not
 * use it should never see it in their dependency graph.
 */
export type ActivityMiddleware<Needs extends AnyPort> = /* as in Interfaces above */;

/**
 * Open one kernel unit per activity attempt, and hand the application context
 * downstream through `temporal-contract`'s own context channel — which is
 * per-invocation, so a future per-unit `forkScope` lands here without an API
 * change.
 */
export const activityUnits =
  <Needs extends AnyPort>(host: RuntimeHost<Needs>): ActivityMiddleware<Needs> =>
  (_invocation, next) =>
    host.run(metaFor(), (ctx) => next({ context: { ctx } }));
```

If `host.run`'s generics need a cast for the heterogeneous return, keep it with a stated reason. **Do not** add a `Result`-unwrapping boundary — `declareActivitiesHandler` owns that, and duplicating it is what the raw path's removal was about.

Export both from `src/index.ts`.

- [ ] **Step 6: Run and watch them pass**

Run: `cd packages/start-temporal && pnpm vitest run src/temporal-runtime.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/start-temporal pnpm-lock.yaml
git commit -m "feat(start-temporal): open a unit per attempt through a contract middleware"
```

---

### Task 3: An in-flight activity finishes when the drain has time

**Files:** Modify `src/test-fixtures.ts`, `src/temporal-runtime.spec.ts`

**Interfaces:** Adds a `gate` fixture — `{ build, arrived: Promise<void>, release: () => void }` — built on the **middleware**, not the deleted raw path.

- [ ] **Step 1: Add the `gate` fixture**

Same `declareActivitiesHandler` + `activityUnits(host)` shape as `contractSeam`, but the activity resolves only once `release()` is called, and calls `entered()` on arrival. Model `arrived`/`release` on `examples/order-api/src/test-fixtures.ts`'s gate.

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

  // WHEN the drain starts and the activity is released once the phase moved.
  // `vi.waitUntil` synchronises rather than asserts — the drain samples
  // `inFlightAtStart` in the same synchronous turn that advances the phase.
  app.requestDrain();
  await vi.waitUntil(() => app.phase() === "draining");
  gate.release();
  await running;

  // THEN the kernel counted it as one unit that COMPLETED, through a real
  // Workflow-Task / Activity-Task loop
  await expect(app.exited).toBeOkWith(
    expect.objectContaining({
      drain: { inFlightAtStart: 1, completed: 1, abandoned: 0 },
    }),
  );
});
```

- [ ] **Step 3: Run it**

Run: `cd packages/start-temporal && pnpm vitest run src/temporal-runtime.spec.ts -t "in-flight activity"`

**Expected: PASS on arrival.** This characterises behaviour Task 2 already built and exists as the regression guard for Task 4, which changes `drain`. That is stated openly rather than dressed as a red. **If it fails, stop and report** — the drain is wrong before Task 4 has touched it.

- [ ] **Step 4: Commit**

```bash
git add packages/start-temporal
git commit -m "test(start-temporal): pin that a drained activity still completes"
```

---

### Task 4: The kernel's deadline releases a hung activity

**Files:** Modify `src/temporal-runtime.ts`, `src/temporal-runtime.spec.ts`, `src/test-fixtures.ts`

This is the reason the package exists.

- [ ] **Step 1: Let `serve` take `drainTimeoutMs`**

Add a second parameter forwarding it into `start`'s options.

- [ ] **Step 2: Write the failing test**

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

  // THEN the exit is not held hostage by a worker that cannot stop: the activity
  // is reported abandoned and the process is released on the kernel's deadline
  // rather than Temporal's `shutdownForceTime`, which is what
  // `Serving.drain(signal)` promises the kernel.
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

Release the gate in the fixture's teardown so the worker can wind down.

- [ ] **Step 3: Run and watch it fail**

Run: `cd packages/start-temporal && pnpm vitest run src/temporal-runtime.spec.ts -t "own deadline"`
Expected: FAIL by timing out, or by `promptly: false` — `stop()` awaits `running`, which cannot settle until Temporal's `shutdownForceTime` (15 s). That is the defect.

- [ ] **Step 4: Race the deadline in `poll`**

```ts
// The kernel's deadline, kept from `drain` so `stop` is released by the same
// abort. Without it the release is only half done: `finish` calls `stop()`
// after the drain has already timed out, and a `stop` that started waiting on
// `running` all over again would put Temporal's `shutdownForceTime` back in
// charge of when the process exits.
let deadline: AbortSignal | undefined;

const stopped = (): AsyncResult<void, never> =>
  deadline === undefined ? running : releasedBy(deadline, running);
```

with `drain` setting `deadline = signal` before `stopPolling()`, both `drain` and `stop` returning `stopped()`, and:

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

Carry the comment explaining that `@temporalio/worker` has no public forced shutdown, so stopping the wait is the only escalation and the worker is left to Temporal's clock.

- [ ] **Step 5: Run and watch both drain tests pass**

Run: `cd packages/start-temporal && pnpm vitest run src/temporal-runtime.spec.ts`
Expected: PASS. **Task 3's test must still pass** — it is the guard that this did not break the happy path.

- [ ] **Step 6: Commit**

```bash
git add packages/start-temporal
git commit -m "feat(start-temporal): release the kernel at its own deadline"
```

---

### Task 5: The coverage gate

**Files:** Modify `vitest.config.ts`, and whatever tests the gate demands

- [ ] **Step 1: Turn on the thresholds**

In `packages/start-temporal/vitest.config.ts`, add to `coverage`:

```ts
      thresholds: { lines: 100, functions: 100 },
```

- [ ] **Step 2: Run and read the report**

Run: `cd packages/start-temporal && pnpm test`

Coverage must be 100% lines and functions **honestly**. Add the missing tests for whatever is uncovered.

**Do not** lower the thresholds, exclude a file, or add a test that executes a line without asserting anything about it. **If a line is genuinely unreachable, stop and report** — the `-http` plan wrongly declared a branch unreachable and nearly shipped an untested behaviour, so assume it is reachable until you have shown otherwise. The likeliest candidates are `whenAborted`'s already-aborted arm and `metaFor`'s fallback to `activityId` when there is no workflow.

- [ ] **Step 3: Commit**

```bash
git add packages/start-temporal
git commit -m "test(start-temporal): enforce full coverage"
```

---

### Task 6: The package README

**Files:** Create `packages/start-temporal/README.md`

Sections, in order. **Read `src/temporal-runtime.ts` and `src/activity-units.ts` before writing a word** — every claim must be true of the code as shipped.

1. Title and one-line claim.
2. **Install** — the six peers, `Node >=20`, and that it is **not yet published**.
3. **The worked example** — the `declareActivitiesHandler` + `activityUnits` snippet from the spec. One integration; do not imply a raw path exists.
4. **What it owns** — the Worker's lifecycle, the unit boundary, the deadline race. And what it does **not**: `Result` → activity failure, which `declareActivitiesHandler` already does. Say so explicitly; a reader coming from `-http` will expect the asymmetry explained.
5. **The drain, and the detached worker** — `worker.shutdown()` stops polling, `run()` settles on Temporal's clock, there is no public forced shutdown, so at the kernel's deadline the runtime stops waiting and the worker keeps winding down until the process exits. This is the package's one surprising behaviour; state it plainly.
6. **`forceAfter` and `gracePeriod`** — keep `forceAfter` at or below the kernel's `drainTimeoutMs`, and why the package cannot do that for you.
7. **The unit boundary** — one unit per **attempt**; `id` is the task token, `traceId` the workflow id, and why a workflow id would be wrong as the id.
8. **Writing a runtime** — the two contracts a runtime owes, and that this package discharges both.

Then `pnpm format` and commit as `docs(start-temporal): …`.

---

### Task 7: Documentation and changeset

**Files:** Modify `CLAUDE.md`, `README.md`; create `.changeset/start-temporal.md`

- [ ] **Step 1: `CLAUDE.md`** — strike `-temporal` from "Deferred, deliberately", leaving `-amqp`. Add it to Shipped. Add a `### @btravstack/start-temporal` subsection to **Public surface** in the same density as the `-http` one. Update "two published packages" to three wherever it appears.

- [ ] **Step 2: Record what did not change** — a line stating `temporal-contract` needed no modification, and why: its `ActivityMiddleware` is the seam, and `createContext` runs once per activity execution. This is the conclusion the spec exists to preserve.

- [ ] **Step 3: Root `README.md`** — remove the `-temporal` row from the deferred table and adjust the surrounding sentence, which scopes "roughly forty lines" to `-amqp`/`-temporal`.

- [ ] **Step 4: Grep for claims this package falsifies** — `packages/start/src/docs-examples.test-d.ts` is a **fifth** doc-sync target `CLAUDE.md` names and was missed last cycle; check it. Also `packages/start/README.md`, `packages/start-http/README.md`, `examples/README.md`.

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

It integrates through `temporal-contract`: add `activityUnits(host)` to
`declareActivitiesHandler`'s middleware and every activity attempt becomes a
kernel unit with the application context injected. `temporal-contract` is not a
peer dependency — the middleware type is structural — and `Result` → activity
failure is deliberately not mapped here, because `declareActivitiesHandler`
already does it.
```

- [ ] **Step 6: Run all six gate commands** and commit as `docs: record @btravstack/start-temporal as shipped`.

---

## Self-Review

**Spec coverage.** Public surface → Tasks 1, 2, 4. `temporal-contract` needs no changes → Task 2 (structural type) and Task 7 Step 2 (recorded). Lifecycle → 4. Error handling → already done in the superseded plan's Task 3, reviewed clean. Unit boundary → 2. Testing → 2–5. Package layout → done. Docs → 6, 7.

**Risks, with fallbacks inline.**

1. **Task 3 passes on arrival by design** — stated openly, not dressed as a red. The superseded plan made that mistake twice.
2. **The `contractSeam` fixture is the fiddliest thing here.** It needs a minimal contract, the middleware, and a host proxy at once. If the contract's shape fights the fixture, report rather than weakening the assertion to something `currentUnit()` can see — `UnitMeta.id` is invisible that way, and `expect.any(String)` would test nothing.
3. **Task 5's coverage gate must be met honestly.** Two candidate "unreachable" lines are named; assume reachable until shown otherwise.
4. **Outstanding from the previous cycle:** commit `c549de6` carries a `docs:` subject over implementer code (a controller `git add -A` during concurrent work). Safe to reword now. Not part of any task.
