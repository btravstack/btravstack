# AGENTS.md

The spec for this repository is [`CLAUDE.md`](./CLAUDE.md). Read that file; it
is authoritative and applies to every agent, not only to Claude Code. The
per-package specs it points at are `packages/<name>/CLAUDE.md`.

This file is a pointer rather than a copy on purpose. It used to be a
find-and-replace duplicate of `CLAUDE.md`, and within two days it had drifted
136 lines and was directing readers to twelve `AGENTS.md` files that do not
exist. One spec, one gate, no second copy to keep in sync.
