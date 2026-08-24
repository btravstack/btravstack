---
"@btravstack/amqp": patch
"@btravstack/temporal": patch
"@btravstack/http": patch
"@btravstack/contract": patch
"@btravstack/config": patch
"@btravstack/observability": patch
"@btravstack/testing": patch
---

The README samples compile again — and now cannot stop. Every `ts` fence in
the package READMEs, the root README and the documentation site is extracted
into generated type-test modules and compiled by `pnpm typecheck`. The sweep
that built the gate fixed the drift it found: the amqp and temporal READMEs'
two-argument `execute` from before the branded tenant, a wrong consumer key,
a missing error-triage arm, and the pre-`defineHttp` router spelling in the
root README.
