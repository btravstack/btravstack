---
"@btravstack/core": minor
---

Allow health checks to opt into gating `/readyz` with `readiness: true` or a
configured cache interval. Concurrent readiness and health probes share each
opted-in check's evaluation, and a healthy refresh restores readiness without
restarting the process. Ordinary checks and liveness keep their existing behavior.
