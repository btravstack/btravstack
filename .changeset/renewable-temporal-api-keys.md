---
"@btravstack/temporal-client": minor
"@btravstack/temporal-worker": minor
"@btravstack/core": patch
---

Allow applications to compose a renewable Temporal bearer credential source
through an `apiKey` port. The source owns acquisition and expiry; the starters
require TLS, refresh through `setApiKey`, and fail closed when the source becomes
unavailable. Clients close and recover on a fresh reading; workers withdraw
readiness and stop so the orchestrator can restart them.

Correct `runMain` to return a failure code when a runtime stops before any
shutdown request. `ExitReport.unexpectedRuntimeStop` distinguishes that path
from an explicit stop, preserving normal caller and signal shutdown behavior.

Close allocated Temporal client connections when initialization or reconnection
fails; retain initialization and cleanup failures when cleanup defects.
