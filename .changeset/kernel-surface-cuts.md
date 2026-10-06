---
"@btravstack/core": minor
"@btravstack/observability": minor
---

**Removed: `LoggerService.log(level, …)` and `runHealthChecks`' second argument.** Neither had a caller.

- `LoggerService` keeps one method per level (`logger.fatal("…")` where `logger.log("fatal", "…")` was written), and `createLogger` no longer returns `log`.
- `runHealthChecks(checks)` takes no options. Each check is held to its own `timeoutMs`, or to `DEFAULT_HEALTH_TIMEOUT_MS` (`800`) when it declares none. That is what `/healthz` already did, since the kernel never passed the option.
