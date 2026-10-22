---
"@btravstack/temporal-worker": minor
---

Configure the worker's deployment task queue through `TEMPORAL_TASK_QUEUE` or
an explicit `taskQueue` option, with the contract's queue retained as the default.
Runtime information reports the effective polling queue. Workflow and
activity-only workers share this configuration without mutating the supplied
contract or changing caller destinations.
