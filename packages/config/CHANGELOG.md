# @btravstack/config

## 0.2.0

### Minor Changes

- f133934: **Configuration, the twelve-factor way, in its own package.** `@btravstack/config`
  exports `Env` — the environment as a port, which `@btravstack/core` provides to
  every graph `start` boots (`process.env`, or `StartOptions.env` for a test) —
  and `Config`:
  `Config.string/integer/port(variable, { default?, min?, max? })` fields,
  `Config.object({...})` composing them into a Standard Schema over the
  environment (any other Standard Schema, a `zod` object over the raw variables
  for instance, is accepted too), and `Config.provider(Port)(schema)` binding a
  port from `Env` — a modeled `ConfigInvalid` naming every offending variable
  when the environment is wrong, which `runMain` maps to sysexits(3)'s
  `EX_CONFIG` (78) rather than the generic startup `1`. The kernel binds its own
  `PROBE_PORT` the same way (default `9000`; `probes` still overrides), and a
  startup failure of any kind is now reported as a `startFailed` kernel event
  before `stopping`, so a bad environment is named on stderr instead of exiting
  silently. An empty or blank variable is an error, never an absent one; `PORT=0`
  stays expressible.

  `@btravstack/http` becomes a starter: `http()` provides
  `HttpRuntime` and `HttpConfig`, bound from `PORT` (default `3000`) and `HOST`
  (default `0.0.0.0`) unless pinned (`http({ port: 0 })` for a test —
  explicit beats environment beats default, per field, through
  `Config.pinned(value, field)`; a pinned field reads nothing from the
  environment, and the module's declared `Env` need and `ConfigInvalid` stay
  whatever is pinned). `RuntimeNeedsGate` is renamed `StartGate`, since it now
  also states `NO RUNTIME`.

  `Config.provider("Name")(schema)` — the name form — mints the port (its
  service is the schema's output) and returns the provider carrying it typed
  (`provider.port`), the shape for a slice that is one application's own; the
  class form `Config.provider(Port)(schema)` stays for a slice that is public
  API another package names. Config is the one sugar that takes a name — several
  config slices per application is normal, and the name is what `ConfigInvalid`
  prints; the starters' `HttpRouter` / `TemporalActivities` / `AmqpHandlers`
  provide the starter's own fixed port and take none.

### Patch Changes

- Updated dependencies [9ca73c5]
- Updated dependencies [b56501f]
  - @btravstack/di@1.0.0
