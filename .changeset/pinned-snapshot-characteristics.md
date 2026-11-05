---
"@btravstack/prisma": minor
---

Allow tenantPinned to establish isolationLevel and readOnly transaction
characteristics before the tenant pin. Preserve connection defaults when omitted
and refuse unsupported values without downgrading isolation.
