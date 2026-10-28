# @btravstack/pothos

## 0.53.0

### Patch Changes

- @btravstack/contract@0.53.0

## 0.52.0

### Patch Changes

- @btravstack/contract@0.52.0

## 0.51.0

### Patch Changes

- @btravstack/contract@0.51.0

## 0.50.0

### Minor Changes

- 777ca82: Add `contractInputSchema` and `contractOutputSchema` under
  `@btravstack/contract/orpc`. They preserve the original Zod schema and its
  client/server codec types, and reject missing, non-Zod or chained schemas at
  composition. The optional entry requires Zod and oRPC contract peers.

  Pothos reuses the input accessor through its existing `contractInput` export;
  install its new `@btravstack/contract` peer alongside the plugin.

### Patch Changes

- Updated dependencies [777ca82]
  - @btravstack/contract@0.50.0

## 0.49.0

No changes in this release.

## 0.48.1

No changes in this release.

## 0.48.0

No changes in this release.

## 0.47.0

No changes in this release.

## 0.46.0

No changes in this release.

## 0.45.1

No changes in this release.

## 0.45.0

No changes in this release.

## 0.44.1

No changes in this release.

## 0.44.0

No changes in this release.

## 0.43.0

No changes in this release.

## 0.42.0

No changes in this release.

## 0.41.0

No changes in this release.

## 0.40.0

No changes in this release.

## 0.39.1

No changes in this release.

## 0.39.0

No changes in this release.

## 0.38.0

No changes in this release.

## 0.37.0

No changes in this release.

## 0.36.0

No changes in this release.

## 0.35.1

No changes in this release.

## 0.35.0

No changes in this release.

## 0.34.0

No changes in this release.

## 0.33.0

### Minor Changes

- e74f94e: Allow `procedureField` and `procedureConnection` to declare field-local refusal maps, merged over shared builder defaults. Local entries take precedence, while compile-time coverage still follows each call's actual failures and input validation.

## 0.32.0

No changes in this release.

## 0.31.0

No changes in this release.

## 0.30.1

### Patch Changes

- 5fcbe04: Preserve sanitized UNAUTHORIZED and FORBIDDEN operation errors with @unthrown/pothos defect masking, including procedure connections and DataLoader keys. Genuine GraphQLError defects remain masked.

## 0.30.0

No changes in this release.

## 0.29.0

No changes in this release.

## 0.28.0

### Minor Changes

- 1fe915f: New package: Pothos fields that call oRPC procedures. `t.procedureField` and
  `t.procedureConnection` validate a field's input through the procedure's own
  contract, decode its answer, and answer each error it declares as the GraphQL
  error class the builder's `orpc: { refusals }` registers for its code — a
  registry missing a code `call` can fail with does not compile. `UNAUTHORIZED` and
  `FORBIDDEN` are answered as GraphQL's own error with `extensions.code`.
  `loadProcedure` and `procedureErrors` give the same answer through a
  DataLoader.
