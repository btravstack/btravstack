---
"@btravstack/core": patch
"@btravstack/entity": patch
"@btravstack/mailer": patch
---

Keep an abandoned application build from starting its runtime after exit, and abort late units before stopping a runtime whose pending start completes after abandonment (#604).

Reject declared/computed field name collisions in entity, abstract root, variant and aggregate declarations, including inherited names, so computed values cannot replace stored identity (#605). Preserve the original defect from a throwing Zod event refinement in aggregate start, emit and replay (#606).

Preserve SMTP rejection recipients for retries, including CC and BCC: use the transport's rejected list when available and the full envelope on a total connection failure (#607).
