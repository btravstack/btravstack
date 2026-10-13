# packages/pothos

Read the root `AGENTS.md` first. This package owns one Pothos plugin:
`procedureField` and `procedureConnection` on the root field builder, the
`orpc: { refusals }` builder option, and the functions a field built by hand
reuses. It builds on `@unthrown/pothos`'s `resultField` and
`resultConnection`, so a procedure's `Err` reaches the client as a member of
the field's union, never as a thrown error.

**It is a package of its own, not part of `@btravstack/graphql-server`.**
The answerer accepts any `GraphQLSchema` and owns no protocol; a helper
validating GraphQL arguments through an oRPC contract would have put an
`@orpc/contract` peer on it (`docs/explanation/deferred-decisions.md`). Here
the gateway that builds its schema with Pothos opts in. It depends on no other
workspace package, so it runs under any GraphQL server.

**Every dependency is a peer.** Pothos registers plugins on its own
`SchemaBuilder` class and `graphql` checks a schema's realm, so a second copy
of either is a schema that does not build or does not run.
`@pothos/plugin-relay` is a required peer: the entry imports
`@unthrown/pothos/relay` so that `procedureConnection` exists on every
builder, and that entry imports the relay plugin. Making it optional would
mean moving `procedureConnection` behind a subpath of its own, the way
`@unthrown/pothos` does. `sideEffects` names the entry, since importing it is
what registers the plugin and the two field methods.

**Refusal maps may belong to fields; coverage is still a compile error.**
`orpc.refusals` holds shared builder defaults. `procedureField` and
`procedureConnection` accept their own `refusals`, merged over those defaults,
so each resource keeps its business refusals locally. The type side uses
`Omit<Shared, keyof Local> & Local`, matching the runtime spread's precedence:
an incompatible local override cannot hide behind a compatible shared entry.
The optional local map defaults to `{}` in the field's generics, preserving
existing builder-only calls and the published options types' type arguments.
An empty `Local` permits only an empty local map. Without that guard, explicit
type arguments defaulting `Local` to `{}` could pass a non-empty map whose
overrides the coverage check never sees. The guard is intersected with `Local`
so ordinary field calls still infer their map's exact keys.

A field's refusals are the codes its procedure declares, read from
the contract's `errorMap`, plus `InvalidInput`, less the two access codes; a
code its `call` can fail with that the merged map lacks fails the field with
`uncovered: "<CODE>"` (`procedure-field.test-d.ts` pins it under both
compilers). Coverage follows `call`'s failure rather than the `errorMap`: a
declared code a narrower `call` handles itself never reaches the field, and a
code the merged map lacks adds no member to its union. A field given neither
shared nor local mappings at runtime answers every declared error as an error
of the operation, because its union has no member for it
(`procedure-field.spec.ts`). `loadProcedure` and `procedureErrors` keep their
explicit map argument; a loader passes the merged shared and resource-local
map itself.

**Access refusals are GraphQL's own error, never a union member and never a
masked defect.** `UNAUTHORIZED` and `FORBIDDEN` refuse the caller, not the
operation. `callProcedure` converts only those oRPC codes to a private
`AccessRefusal` marker with a fixed message and no service details. The plugin
restores that marker at `wrapArgMappers`, outside Result settlement and the
errors plugin, so even a base `Error` default cannot claim it. `loadProcedure`
returns the marker directly. An ordinary `GraphQLError` defect, including one
carrying either access code, stays masked by `@unthrown/pothos`.

**`contractInput` throws, and only at schema build.** A procedure whose
contract does not hold exactly one Zod input schema is a mistake in the
schema's source; it is read as the schema is built, never per request. Inside
a resolver the same read goes through `contractCall`, where it is a defect.

**`loadProcedure` answers a `Promise`**, the exception to thesis #6 that a
DataLoader's batch function forces: it answers a value or an `Error` per key.

**The specs inline Pothos and `@unthrown/pothos`** (`test.server.deps.inline`
in `vitest.config.ts`). Externalised, the specs' `graphql` and the one Pothos
builds with are different module instances, and `@unthrown/pothos` registers
its plugin on a Pothos the inlined builder never sees.

**The package exports ESM only.** Its required `@orpc/client` peer is
ESM-only, so a `require()` of a CommonJS build fails on every Node before
`require(esm)` (measured on the 22.0 floor by the consumer check). A
CommonJS build also hands Pothos' default export to the plugin as the whole
module record, because the bundler applies Node's interop to a CommonJS
dependency of an ES module, and `registerPlugin` is not on it — the same
failure `@unthrown/pothos@0.1.0`'s own CommonJS entry has.
