# Agent skills

This repository publishes reusable agent instructions alongside the framework.

Install the btravstack skill, and the unthrown skill it builds on, with:

```sh
npx skills add btravstack/btravstack --skill btravstack
npx skills add btravstack/unthrown --skill unthrown
```

The skill is procedural rather than a copy of the reference: it teaches an
agent how to add a capability, read a wiring error and test a root. The
documentation site remains the source of truth for the surface. Every `ts`
fence under this directory is compiled by the doc-samples gate, so a sample
that stops compiling fails `pnpm typecheck`.
