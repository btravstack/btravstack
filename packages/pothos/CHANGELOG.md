# @btravstack/pothos

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
