# packages/config

Configuration. The root `CLAUDE.md` is the authoritative spec, and the surface
is `docs/reference/config.md`; this file holds what only matters under
`packages/config/`. Keep it in sync with the code and `README.md` in the same
commit.

## Public surface

- **`Env`** is declared **once**, here; the kernel imports it to provide it, so
  di's duplicate-id warning never fires.

## Tests

The kernel-facing half — the provider through `start`, `runMain`'s `78`,
`PROBE_PORT` — lives in `packages/core/src/config.spec.ts`.
