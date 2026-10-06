---
"@btravstack/core": patch
---

`UnitRecord.unitId` is now a UUID (`crypto.randomUUID()`) instead of a per-process `u1`, `u2`… counter, so it is unique across replicas as the documentation already promised. A query that grouped lines by `unitId` across pods no longer merges unrelated units.
