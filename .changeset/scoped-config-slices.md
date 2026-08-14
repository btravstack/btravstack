---
"@btravstack/config": minor
---

configuration parsed from the environment, as one value that is both port and module

`Config(id)(shape, options?)` declares a single value that is both a
`@btravstack/di` port token and the module serving it from the environment,
so `imports: [amqpConfig]` and `ctx.get(amqpConfig)` name the same thing. The
signature mirrors `@btravstack/entity`'s `Entity(tag)(fields, options?)`:
curried on the identity, then the field map, then an optional `{ prefix }` —
omitted, the prefix is the screaming-snake of the identity. Each field is
validated by any Standard Schema library.

Being one value costs nothing in adaptability, because it is a token first:
its module statics are consulted only when it appears in a module's
`imports:`, so a test can hand it a literal `Provider(amqpConfig)({ value })`
without importing it, with no environment involved.

`Config.source` provides the environment as a port rather than an ambient
`process.env` read, so validation and injection can never disagree about what
the environment was. `Config.collect` walks a module tree for every reachable
config, and `Config.parse` validates them all against one source, aggregating
every wrong variable into one `ConfigInvalid` instead of stopping at the
first — an operator who mistyped three variables learns all three from one
failed boot. `describeIssues` formats them, `ConfigType<T>` names a parsed
config's type, and `@btravstack/config/zod` ships `wholeNumber` and `port`
builders that guard the `Number("") === 0` trap.

Needs a `@btravstack/di` that exports `ConcretePortClass` and `PortInstance`
— the two names declaration emit requires for a port built from data, one for
declaring a config and one for exporting it from a composition root.
