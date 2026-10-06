# @btravstack/entity

Optional domain-modelling package. It depends on Zod, unthrown and `@unthrown/standard-schema` as peers and has no dependency on any other btravstack package. Its public root is the `Entity` facade, with top-level type exports required by declaration emit. The [entity guide](../../docs/entity/index.md) and [API config](../../docs/typedoc.entity.json) own its published explanation and signatures.

The builder derives `input`, `output`, `createInput` and `updateInput` from one field map. Construction, update and rehydration converge on the same validation and invariant path; data is frozen and a result carries structured `InvalidEntity` issues. Aggregate roots use events and sealed decisions, with version checks and persistence left to an adapter. No I/O belongs in this package. Entity fields are nominal unless explicitly marked unbranded.

The package's type behaviour is its product. `src/*.test-d.ts` guards the compile-time surface. `examples/entity-billing-domain/src/emit-guards.ts` is the consumer declaration-emission gate: its `typecheck` emits with this repository's TypeScript and with `typescript-consumer`, then checks the emitted declarations under the consumer compiler. Keep this gate when changing exported types, especially around branded fields, abstract roots, unions, factories and aggregates. Do not add `--skipLibCheck` to the emitted-output check.

`package.json` participates in the fixed Changesets group with every published package; do not introduce a separate version. Maintain `node >=22` as the published floor while the root may require a newer development Node. The guide lives under `docs/entity/`; old `https://btravstack.github.io/entity/` URLs need a redirect from the former site when this migration deploys.
