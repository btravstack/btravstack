/**
 * The compile-time half of the seam: `outbox()` owes exactly the two ports an
 * application must answer — where the rows are, and what publishing one means
 * — and a root that forgets either does not compile.
 *
 * Type-checked by this package's `typecheck` script, never executed.
 */
import { Env } from "@btravstack/config";
import { HealthChecks } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";
import { OkAsync } from "unthrown";

import { memoryOutboxStore } from "./memory.js";
import { OutboxPublisher, OutboxStore } from "./outbox.js";
import { outbox } from "./relay.js";

const env = Provider(Env)({ inject: {}, value: {} });
const store = Provider(OutboxStore)({ inject: {}, value: memoryOutboxStore() });
const publisher = Provider(OutboxPublisher)({
  inject: {},
  value: { publish: () => OkAsync() },
});

const Wired = Module("Wired")({
  imports: [outbox({ tenants: ["acme"] })],
  provides: [env, store, publisher],
  exports: [HealthChecks],
});
const _wired = Module.scoped(Wired, () => OkAsync());

const Unpublished = Module("Unpublished")({
  imports: [outbox({ tenants: ["acme"] })],
  provides: [env, store],
  exports: [HealthChecks],
});
// @ts-expect-error — UNSATISFIED DEPENDENCIES: nothing provides `OutboxPublisher`.
const _unpublished = Module.scoped(Unpublished, () => OkAsync());

const Storeless = Module("Storeless")({
  imports: [outbox({ tenants: ["acme"] })],
  provides: [env, publisher],
  exports: [HealthChecks],
});
// @ts-expect-error — UNSATISFIED DEPENDENCIES: nothing provides `OutboxStore`.
const _storeless = Module.scoped(Storeless, () => OkAsync());

void _wired;
void _unpublished;
void _storeless;
