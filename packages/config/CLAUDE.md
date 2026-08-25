# packages/config

Configuration's public surface. The root `CLAUDE.md` is the authoritative spec;
this file holds what only matters under `packages/config/`. Keep it in sync with
the code and `README.md` in the same commit — the package ships no
`docs-examples.test-d.ts` (the kernel's compiles the shared sample).

## Public surface

- **`Env`** — `Port("Env")<Environment>`, `Environment` being
  `Readonly<Record<string, string | undefined>>` (`process.env`'s shape).
  Declared **once**, here; the kernel imports it to provide it, so di's
  duplicate-id warning never fires. Whoever boots a graph provides it — the
  kernel does for every `start`; a bare `Module.scoped` needs
  `Provider(Env)({ value })`, which is what this package's own fixtures do.
- **`Config.string` / `integer` / `port`** — `ConfigField<T>`
  factories over one variable: `{ variable, parse(raw: string | undefined) →
Result<T, ConfigFieldInvalid> }`. All go through one `present()` helper that
  fixes the shared semantics (unset → default or `is required`; trimmed empty →
  `is set but empty`; otherwise the field's own `read`), so "empty is an
  error, never a default" is decided in one place. `integer`/`port` share
  `integerIn(min, max)`: `Number()` + `Number.isInteger` + inclusive bounds.
- **`Config.pinned(value, field)`** — `field` unless `value` is given, then a
  field answering `value` that reads nothing (same `variable`, `parse: () =>
Ok(value)`). What a starter's options do to its own fields — explicit beats
  environment beats default, **per field** — declared once here rather than
  as a local helper in each starter (`http` and `temporal` had one apiece).
- **`Config.object(fields)`** — a hand-rolled Standard Schema v1
  (`~standard: { version: 1, vendor: "btravstack", validate }`) over
  `Environment`, typed `ConfigSchema<Environment, { [K]: T }>`. `validate` is
  synchronous, walks EVERY field (one round trip for the operator), reports
  each failure as an issue with `path: [variable]`, and never throws: a field
  whose `parse` defects (a bug in the field) is folded into an issue against
  its variable.
- **`Config.provider(port)(schema)` / `Config.provider(name)(schema)`** — two
  overloads over one body: `Provider(port)({ env: Env }, { make })`, `make` awaiting
  `schema["~standard"].validate(env)` inside `fromSafePromise` over an `async`
  wrapper (a third-party schema may be async and may throw — the throw
  becomes the defect it is) and answering `Ok(value)` or
  `Err(new ConfigInvalid({ port: port.portId, issues }))`. The **name** form
  mints the port (`class extends Port(name)<Output> {}`, service = the
  schema's output) and returns `Provider<PortInstance<Name, Output>,
ConfigInvalid, Env> & { readonly port: PortClassOf<Name, Output> }` — di's
  `PortClassOf` is the nameable spelling of that class (`{ portId: Name; new
(): PortInstance<Name, Output> }`; the same type the starters spell their
  fixed router / activities / handlers ports through), because the class
  expression's own type expands the brand keys in declaration emit. The **class** form returns `Provider<InstanceType<P>,
ConfigInvalid, Env> & { readonly port: P }` (di's own `Provider(port)`
  return). The implementation signature returns `unknown`: no one type is
  assignable both ways to both overloads (`Provider` is contravariant in its
  port). Which to use: the name form for a slice that is one application's
  own (`relayConfig.port` in a dependent's deps); the class form for a slice
  that is public API another package names (`HttpConfig`).
- **`ConfigSchema<Input, Output>`** — the structural slice of Standard Schema
  v1 this package speaks, restated locally so it depends on nothing;
  `ConfigIssue` likewise (`{ message, path? }`). A `zod`/`valibot`/`arktype`
  schema satisfies it as is.
- **`ConfigInvalid`** — `TaggedError("ConfigInvalid")<{ port, issues }>`,
  `message` = `"<port> could not be configured:\n  VAR: reason"` per issue
  (an object path segment prints its `key`; no path prints `(environment)`).
  **`ConfigFieldInvalid`** — `TaggedError<{ reason }>`, `message = reason`;
  the modeled error of a field so `Config.object`'s match names it
  (`P.tag("ConfigFieldInvalid")`) instead of a catch-all over `string`.
- Peer dependencies: `@btravstack/di`, `unthrown`. Nothing else — that is the
  point of hand-rolling the schema.

## Tests

`config.spec.ts` (15 specs): `Config.object`'s semantics (defaults, parsed
values, `PORT=0`, empty, blank ×2 + malformed named in one validation, `3.5`,
bounds, a required field, a defecting field), `Config.pinned` (the pin over
the environment, the field otherwise), `ConfigInvalid.message`, and `Config.provider` end to end through a real
`Module.scoped` graph with `Env` provided as a value (`bound`, `boundThrough`
fixtures in `src/__tests__/test-fixtures.ts`) — including an async third-party
Standard Schema. Coverage 100% lines/functions. The kernel-facing half — the
provider through `start`, `runMain`'s `78`, `PROBE_PORT` — lives in
`packages/core/src/config.spec.ts`.
