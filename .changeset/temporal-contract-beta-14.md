---
"@btravstack/temporal-worker": minor
"@btravstack/temporal-client": minor
---

Adopt `@temporal-contract/*` 8.0.0-beta.14: cross-queue `context.executeActivity` from workflows and standalone activities from clients. `TemporalModule`'s `workflows` is optional, so an activity-only contract (a rendering pool's queue) boots a worker with no workflow bundle. `ensureSchedule` no longer answers `WorkflowNotInContractError`, which beta.12 removed: an undeclared name is a defect.
