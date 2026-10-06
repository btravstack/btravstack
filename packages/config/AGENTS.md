# packages/config

Configuration. The root `AGENTS.md` is the authoritative spec, and the surface
is `docs/reference/config.md`; this file holds what only matters under
`packages/config/`. Keep it in sync with the code and `README.md` in the same
commit.

## Public surface

- **`Env`** is declared **once**, here; the kernel imports it to provide it, so
  di's duplicate-id warning never fires.

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
