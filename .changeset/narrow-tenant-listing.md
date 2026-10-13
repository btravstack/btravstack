---
"@btravstack/prisma": minor
---

Add `tenantListing` on `/rls`: declare a narrow tenant-ID capability once, generate a checked Prisma migration installing its security-definer function, owner policy and execution grant, and page through tenant IDs (at most 100 per call) through a typed Result-returning query while ordinary application reads remain row-secured.
