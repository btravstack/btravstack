---
"@btravstack/amqp": patch
"@btravstack/temporal": patch
"@btravstack/di": patch
"@btravstack/observability": patch
---

Documentation only: the mentions of the example slices now use the fixed
`slice` / `piece` export convention, and the composition roots shown spread
the generated `slices` array. The examples' slice trees are generated into a
committed `src/slices.gen.ts`.
