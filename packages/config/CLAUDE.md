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
- **`Config.string` / `integer` / `port` / `boolean`** — `ConfigField<T>`
  factories over one variable: `{ variable, parse(raw: string | undefined) →
Result<T, ConfigFieldInvalid> }`. All go through one `present()` helper that
  fixes the shared semantics (unset → default or `is required`; trimmed empty →
  `is set but empty`; otherwise the field's own `read`), so "empty is an
  error, never a default" is decided in one place. `integer`/`port` share
  `integerIn(min, max)`: `Number()` + `Number.isInteger` + inclusive bounds.
- **`Config.object(fields)`** — a hand-rolled Standard Schema v1
  (`~standard: { version: 1, vendor: "btravstack", validate }`) over
  `Environment`, typed `ConfigSchema<Environment, { [K]: T }>`. `validate` is
  synchronous, walks EVERY field (one round trip for the operator), reports
  each failure as an issue with `path: [variable]`, and never throws: a field
  whose `parse` defects (a bug in the field) is folded into an issue against
  its variable.
- **`Config.provider(port, schema)`** — `Provider(port)([Env], { make })`;
  `make` awaits `schema["~standard"].validate(env)` inside `fromSafePromise`
  over an `async` wrapper (a third-party schema may be async and may throw —
  the throw becomes the defect it is) and answers `Ok(value)` or
  `Err(new ConfigInvalid({ port: port.portId, issues }))`.
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

`config.spec.ts` (14 specs): `Config.object`'s semantics (defaults, parsed
values, `PORT=0`, empty, blank ×2 + malformed named in one validation, `3.5`,
bounds, boolean spellings, a required field, a defecting field),
`ConfigInvalid.message`, and `Config.provider` end to end through a real
`Module.scoped` graph with `Env` provided as a value (`bound`, `boundThrough`
fixtures in `src/test-fixtures.ts`) — including an async third-party
Standard Schema. Coverage 100% lines/functions. The kernel-facing half — the
provider through `start`, `runMain`'s `78`, `PROBE_PORT` — lives in
`packages/core/src/config.spec.ts`.
