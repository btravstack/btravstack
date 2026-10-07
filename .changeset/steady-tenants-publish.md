---
"@btravstack/outbox": patch
---

Run each configured tenant's relay loop independently so a pending claim or publish for one tenant does not block another tenant's due messages. Keep publication serial within each tenant and wait for in-flight work on stop.
