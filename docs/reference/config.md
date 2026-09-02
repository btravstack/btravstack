---
title: "@btravstack/config"
description: The complete surface of @btravstack/config — the Env port, the Config fields, Config.object, Config.provider and the two errors.
---

# @btravstack/config

> **Reference.** A complete, structured description of `@btravstack/config`:
> the `Env` port, the field constructors, `Config.object`, `Config.provider`
> and the errors they answer. For the task, see
> [Configure from the environment](/how-to/configure-from-the-environment); for
> the generated signatures, see the [API reference](/api/config/).

`@btravstack/config` peers on `@btravstack/di` and `unthrown` and depends on
nothing else. Every export is named below.

## `Env` and `Environment`

<!-- doctest: signature=@btravstack/config -->

```ts
type Environment = Readonly<Record<string, string | undefined>>;
class Env extends Port("Env")<Environment> {}
```

`Env` is the process environment **as a port**. `@btravstack/core`'s `start`
provides it to every graph it boots — `process.env` by default,
`StartOptions.env` for a test — the same way it discharges `Scope`, which is
why `start` accepts `Module<X, E, Scope | Env>`. Outside the kernel (a bare
`Module.scoped`), provide it yourself: `Provider(Env)({ inject: {}, value: process.env })`.
A module that provides `Env` itself is booted without the kernel's copy, and
its own wins.

## Fields

A field reads **one** variable into a typed value:

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
type ConfigField<T> = {
  readonly variable: string;
  readonly parse: (raw: string | undefined) => Result<T, ConfigFieldInvalid>;
  /** The same rule over a value that is already a `T` — a pin, or a default. Optional. */
  readonly check?: (value: T) => Result<T, ConfigFieldInvalid>;
};
```

| Constructor                          | Value                                                                                                                 | Options                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `Config.string(variable, options?)`  | a non-empty string                                                                                                    | `{ default?: string }`                             |
| `Config.integer(variable, options?)` | a whole number, bounds inclusive                                                                                      | `{ default?: number; min?: number; max?: number }` |
| `Config.boolean(variable, options?)` | a flag: `true`/`false`, `1`/`0`, `yes`/`no` or `on`/`off`, case-insensitive                                           | `{ default?: boolean }`                            |
| `Config.port(variable, options?)`    | a whole number in `0..65535`, `0` (an ephemeral bind) included                                                        | `{ default?: number }`                             |
| `Config.pinned(value, field)`        | `field` unless `value` is given, then a field answering `value` and reading nothing — checked by the field's own rule | —                                                  |

Semantics shared by every field, in one place:

| Raw value                   | Result                                                                   |
| --------------------------- | ------------------------------------------------------------------------ |
| unset (`undefined`)         | the `default`, or `ConfigFieldInvalid("is required")` when there is none |
| `""` or whitespace only     | `is set but empty` — an error, **never** the default                     |
| `abc` (integer/port)        | `is not a whole number: "abc"`                                           |
| `3.5` (integer/port)        | `is not a whole number: "3.5"` — named, not truncated                    |
| out of range (integer/port) | `must be between <min> and <max>, got <n>` — both bounds inclusive       |
| `0` (port)                  | valid — a port's floor is `0` so an ephemeral bind stays expressible     |

Values are **trimmed** before being read, `Config.string` included: `X=" abc "`
binds `"abc"`. That is what makes a whitespace-only variable "set but empty"
rather than a value, and it is the one thing to know before putting a secret
whose surrounding whitespace is significant in the environment — pin that one
through the composition root, where `Config.pinned` hands the value over
untouched.

Integers are `Number()` plus `Number.isInteger`; an unbounded `Config.integer`
spans the safe-integer range. `""` being an error rather than an absent
variable is what stops `PORT=` binding the ephemeral port through
`Number("") === 0`.

A flag is `true`/`false`, `1`/`0`, `yes`/`no` or `on`/`off`, in either case.
Anything else is an **error rather than a falsy reading**: a deployment that
wrote `HTTP_COMPRESSION=enabled` meant to turn it on, and silently reading that
as `false` is a configuration bug nothing reports.

`Config.pinned` is what a starter's options do to its own fields, so
precedence is **explicit > environment > default, per field**:
`http({ port: 0 })` pins `PORT` and still reads `HOST`.

A pin is **validated by the field's own `check`**, where the field has one.
`Config.pinned(-1, bodyLimit)` is a `ConfigInvalid` at graph build, with the
message the deployment route would have produced for `HTTP_BODY_LIMIT=-1` — and
`Config.pinned(NaN, …)` likewise, which is the case that used to disable a limit
in silence (`size > NaN` is `false`). Defaults are checked on the same rule.

`integer` and `port` carry a `check`; **`string` does not**, and that is
deliberate: "set but empty" is a rule about the raw variable — a deployment
mistake — where a pinned `""` is a decision, and `http({ cors: false })` pins
exactly that as its off switch. A field written by hand without a `check`
likewise accepts whatever it is pinned, so nothing about the shape above stops
compiling.

## `Config.object(fields)`

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
Config.object<F extends Record<string, ConfigField<unknown>>>(fields: F):
  ConfigSchema<Environment, { readonly [K in keyof F]: /* the field's T */ }>
```

A record of fields, as a **Standard Schema v1** over the environment
(`~standard: { version: 1, vendor: "btravstack", validate }`). `validate`:

- is synchronous and **never throws** — a field whose `parse` defects (a bug
  in the field, not the deployment) is folded into an issue against its
  variable, `message: String(cause)`;
- reads **every** field before answering, so one validation names every
  offending variable at once, in declaration order;
- reports each failure as `{ message, path: [variable] }`.

`ConfigSchema<Input, Output>` is the structural slice of Standard Schema this
package speaks, restated locally so it depends on nothing:

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
type ConfigSchema<Input, Output> = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) =>
      | { readonly value: Output; readonly issues?: undefined }
      | { readonly issues: readonly ConfigIssue[] }
      | Promise</* either of the above */>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
};

type ConfigIssue = {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
};
```

Any Standard Schema — a `zod`, `valibot` or `arktype` object over the raw
variables, synchronous or asynchronous — is accepted wherever a `ConfigSchema`
is. The fields exist so a starter, and an application with ordinary needs,
bring no schema library at all.

## `Config.provider`

Two overloads over one body, curried like di's own `Provider(port)(…)`: the
first call names the port, the second says how it is bound.

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
Config.provider<P extends AnyPort>(port: P):
  (schema: ConfigSchema<Environment, ServiceOf<P>>) =>
    Provider<InstanceType<P>, ConfigInvalid, Env> & { readonly port: P };

Config.provider<const Name extends string>(name: Name):
  <Output>(schema: ConfigSchema<Environment, Output>) =>
    Provider<PortInstance<Name, Output>, ConfigInvalid, Env> & { readonly port: PortClassOf<Name, Output> };
```

| Form                              | When                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `Config.provider(Port)(schema)`   | the port is public API another package names (`HttpConfig`); you declared it, and pass the class                         |
| `Config.provider("Name")(schema)` | the slice is one application's own; the port is minted, typed by the schema's output, and handed back on `provider.port` |

The provider has dep `[Env]` and a `make` arm that awaits
`schema["~standard"].validate(env)` inside `fromSafePromise` — an async or
throwing third-party schema is handled, a throw becoming the defect it is —
and answers `Ok(value)` or `Err(new ConfigInvalid({ port: port.portId, issues }))`.
The port is built with the rest of the graph, so a bad environment is a
modeled startup `Err` in the module's own error channel, still typed.

```ts
import { Config, Env } from "@btravstack/config";
import { Module, Port, Provider } from "@btravstack/di";

class Database extends Port("Database")<{ readonly url: string }> {}

const databaseConfig = Config.provider("DatabaseConfig")(
  Config.object({
    url: Config.string("DATABASE_URL"),
    poolSize: Config.integer("DATABASE_POOL_SIZE", {
      min: 1,
      max: 64,
      default: 8,
    }),
  }),
);

const Persistence = Module("Persistence")({
  needs: [Env],
  provides: [
    databaseConfig,
    Provider(Database)({
      inject: { config: databaseConfig.port },
      sync: ({ config }) => ({ url: config.url }),
    }),
  ],
  exports: [Database],
});
```

`Persistence` carries `ConfigInvalid` in its error channel and `Env` in its
needs; the kernel discharges the second.

## Errors

**`ConfigInvalid`** — `TaggedError("ConfigInvalid")<{ port: string; issues: readonly ConfigIssue[] }>`.
The message is one line per issue, naming the port and every variable:

```text
HttpConfig could not be configured:
  PORT: is required
  HOST: is set but empty
```

An object path segment prints its `key`; an issue with no path prints
`(environment)`. Under `runMain` a `ConfigInvalid` — or a `RuntimeStartFailed`
whose `cause` is one, the kernel's own `PROBE_PORT` — is exit code `78`; see
[runMain and exit codes](/reference/core/exit-codes).

**`ConfigFieldInvalid`** — `TaggedError("ConfigFieldInvalid")<{ reason: string }>`,
`message = reason`. The error a single field's `parse` answers, so
`Config.object` matches it by tag rather than over a bare `string`. It never
leaves `Config.object`; a caller sees `ConfigInvalid`.

## Summary of exports

| Export               | Kind                                                                |
| -------------------- | ------------------------------------------------------------------- |
| `Env`                | port                                                                |
| `Environment`        | type                                                                |
| `Config`             | value — `string`, `integer`, `port`, `pinned`, `object`, `provider` |
| `ConfigField<T>`     | type                                                                |
| `ConfigSchema<I, O>` | type                                                                |
| `ConfigIssue`        | type                                                                |
| `ConfigInvalid`      | error                                                               |
| `ConfigFieldInvalid` | error                                                               |
