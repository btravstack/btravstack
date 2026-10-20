# @btravstack/pothos

[Pothos](https://pothos-graphql.dev) fields that call
[oRPC](https://orpc.dev) procedures, for a GraphQL gateway in front of
contract-first services. The default export is the plugin, listed after
`@unthrown/pothos`'s:
`plugins: [RelayPlugin, ErrorsPlugin, UnthrownPlugin, OrpcPlugin]`.

- `t.procedureField(procedure, { type, call, input, output, refusals? })` validates the
  field's input through the procedure's own contract before calling it,
  decodes the answer with `output`, and answers each error the procedure
  declares as the GraphQL error class registered for its code — a member of
  the field's result union. Field-local `refusals` override the builder's
  shared `orpc: { refusals }` defaults. Together the maps must cover every
  error `call` can return and `InvalidInput`; a missing code does not compile.
  A declared error handled by a narrower `call` needs no entry.
- `t.procedureConnection(procedure, { …, connection })` is the same for a
  Relay connection, with the decoded page folded by `connection`.
- `UNAUTHORIZED` and `FORBIDDEN` are answered as GraphQL's own error, with
  `extensions.code`, whether the procedure declares them or not.
- `loadProcedure` and `procedureErrors` are the same answer through a
  DataLoader; `contractCall`, `contractInput` and `contractOutput` are the
  contract half on its own.

Every dependency is a peer: Pothos plugins and `graphql` each need one copy.

```sh
pnpm add @btravstack/pothos @pothos/core @pothos/plugin-errors @pothos/plugin-relay \
  @unthrown/pothos@^0.1.2 graphql unthrown zod \
  @orpc/client@2.0.0-beta.44 @orpc/contract@2.0.0-beta.44
```

See
[Resolve GraphQL fields from oRPC procedures](https://btravstack.github.io/btravstack/how-to/resolve-graphql-fields-from-orpc).
