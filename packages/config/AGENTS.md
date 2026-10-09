# packages/config

Configuration. The root `AGENTS.md` is the authoritative spec, and the surface
is `docs/reference/config.md`; this file holds what only matters under
`packages/config/`. Keep it in sync with the code and `README.md` in the same
commit.

## Public surface

- **`Env`** is declared **once**, here; the kernel imports it to provide it, so
  di's duplicate-id warning never fires.

## The variables travel in the needs channel (#465)

A field's type carries its variable and whether it must be set
(`ConfigField<T, V, Need>`); `Config.object`'s input type is the environment it
reads; `Config.provider` and `Config.env` put that in the provider's needs as
`EnvReading<Required, Optional>`; `EnvironmentFor<N>` is the record a graph
with needs `N` accepts, and the kernel types `start`'s `env` by it. Five things
are load-bearing:

- **`"~env"` is a string key, not a symbol.** A module's needs are printed into
  every consumer's declarations, and di's brands taught what a private symbol
  in an expanded intersection costs (TS4023).
- **`EnvNeed`'s key computations are inline**, not named helpers. Declaration
  emit prints a named alias unreduced, and a consumer exporting a module would
  then name an alias this package does not export. Measured: the needs printed
  as `EnvReading<RequiredKeys<…>, …>` until they were inlined.
- **A pin decides a variable's need from the options' TYPE.** `Config.pinned`
  reads nothing when its value is certainly there, reads the field's own need
  when it is certainly absent, and leaves the variable optional when its type
  admits both. A starter whose options pin a variable with no default
  (`jwtAuthenticator`, `oidc()`, `sessionAuthenticator`, `sessionCodec`,
  `outbox`) infers its options as written — one type parameter `O` — and
  spells its needs with `Unpinned<O, Key, Variable>` / `MaybePinned<…>`, so an
  unpinned `HTTP_JWT_ISSUER` is required at the boot site. The shape is
  `<const O extends Options>(options: O & OptionsAs<O, Options>)`, and each
  part of it was a review finding:
  - **`O`, not one parameter per option.** A per-option parameter inferred
    `string` from an optional key (`{ jwks?: string }`), reading the variable
    as pinned when it may be absent; and under `oidc<Identity>(…)` — the one
    uncurried starter — explicit type arguments defaulted the rest to
    `undefined` and refused the call's own pins. `oidc()`'s `O` defaults to
    `OidcOptions<P>`, so there its variables fall back to optional.
  - **`O` naked, and constrained.** Behind a mapped type, `O` was inferred by
    reverse mapping: a conditional options object kept one branch and refused
    the other, and an annotated `SessionCodecPins` argument matched the plain
    half and left `O` at its default. Naked, `O` is the argument's type — a
    union or an annotation included; the constraint keeps the contextual type
    a `principal` callback needs, and a mistyped value fails it and is refused
    at its key.
  - **`OptionsAs<O, T>`** maps a key `T` does not know to `never`, so a
    misspelt option is still an error at its own key (`T & O` alone let it
    join `O` silently).
  - **The pin helpers distribute over `O`.** A pin one branch of a union sets
    is only maybe set, so `Unpinned` holds when every member leaves it out and
    `MaybePinned` when some member may set it.
    A variable WITH a default stays optional however it is pinned, which is why
    `httpServer`, the workers and the kernel needed none of this.
- **`EnvPortFor` has a zero-argument constructor**, as `Env` does.
  `InstanceType` matches against `(...args: any)`, and `any` is not assignable
  to `never`, so a `(...args: never)` constructor answers `any` — which every
  check then passes. Measured: `sessionCodec`'s annotation passed vacuously
  until this changed.
- **A reader that names nothing opens the record.** Plain `Env` in a needs
  union — a provider injecting it whole, a field typed `ConfigField<T>` — makes
  `EnvironmentFor` the open `Environment`, which is what every graph accepted
  before. A starter whose module type spells plain `Env` therefore opens every
  root composing it, which is why each starter's annotation names its
  variables; over a generic `variablePrefix` the schema's own needs cannot
  resolve, so those annotations state them and cast.

## Deliberately not here (#167)

The package reads the process environment once, as the graph is built. The
four things around that are the platform's, each for its own reason — the
Kubernetes shape is `docs/how-to/configure-a-kubernetes-deployment.md`:

- **Profiles are the deployment's.** An overlay per environment (kustomize,
  Helm values) is a reviewed file stating the difference; a profile selector
  would have the process carry every environment's defaults and pick one, so a
  forgotten variable becomes a plausible wrong value instead of the
  `ConfigInvalid` an unset required field is today. That holds only for a
  REQUIRED field the shared base does not carry: a defaulted one takes its
  default, and a base value is inherited by every overlay that merges.
- **File layering is the runtime's.** `node --env-file` reads a file before
  the process starts, which `pnpm dev` already uses; reading one here would
  make "what the framework validated" and "what was in the environment" two
  surfaces that can disagree.
- **Secrets are the platform's.** A secret store syncs into a Kubernetes
  Secret, referenced as an environment variable; a client for Vault or SSM
  here would be a dependency in a package that has none, and a network call
  inside graph construction.
- **Refresh is a restart.** A live-reloaded configuration is a consistency
  problem at every reader — a pool sized by the old value, a timeout read
  from the new — and validation would run once and never again. A restart is
  cheap and drains, and a bad value then fails the NEW pod's boot with `78`.
  The old pods keep serving only under a `RollingUpdate` with
  `maxUnavailable: 0`; `Recreate` has terminated them first.

## Tests

The kernel-facing half — the provider through `start`, `runMain`'s `78`,
`PROBE_PORT` — lives in `packages/core/src/config.spec.ts`.
