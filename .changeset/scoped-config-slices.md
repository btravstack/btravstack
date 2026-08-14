---
"@btravstack/config": minor
---

configuration parsed from the environment, as a port and adapter

`Config(port, "PREFIX")({ key: validator })` implements an ordinary
`@btravstack/di` port — declared by the starter with `Port(id)<Service>` —
as a module that parses `PREFIX`-scoped environment variables, validated
with any Standard Schema library. The port stays adaptable: a test can hand
it a literal `Provider(port)({ value: ... })` instead, with no config module
involved. `Config.source` provides the environment as a port rather than an
ambient `process.env` read, so validation and injection can never disagree.
`Config.collect` walks a module tree for every reachable env adapter, and
`Config.parse` validates them all against one source, aggregating every
wrong variable into one `ConfigInvalid` instead of stopping at the first.
`@btravstack/config/zod` ships `wholeNumber` and `port` builders that guard
against the `Number("") === 0` trap.
