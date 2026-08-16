---
"@btravstack/core": minor
"@btravstack/testing": minor
---

`StartOptions.unit` — a module the kernel forks around **every unit**. Its
providers are constructed as a unit opens, reading anything the application
context carries, and torn down as it closes — while the unit's ambient record
is still open, so a teardown log line carries the request's own trace id. Unit
work receives the forked `Context`, which makes a per-request scope
transparent: a handler routes, and no application code calls
`Module.forkScope`.

`start`'s compile-time gate also covers the fork's own direction: the unit
module's needs must be met by the application module's exports (or `Scope`,
or `Env`). A runtime's `needs` are checked against the application module's
exports alone — a unit-only port is rejected at the call site, since
`RuntimeHost.ctx` never carries it (see below). The unit
module's error channel is pinned to `never` — a construction failure at unit
scope has no modeled channel to land in, so it rides the unit's defect path,
which every runtime already answers.

A unit finaliser that fails is emitted as a `teardownError` event and kept off
`ExitReport.teardownErrors`, which is the application scope's.

Two things a runtime author should know. `RuntimeHost.ctx` remains the
application context: a unit-provided port exists only while a unit is open,
which is why the gate refuses a runtime that names one. And with a unit module the unit's
work runs only once the fork is built — after an `await` when a provider is
async — so a runtime subscribing to an event from inside its work must check
whether it already fired. Without the option, unit work receives the
application context exactly as before, synchronously. This closes the "Per-unit
ports" deferral: `RunUnit` was typed for this fork from the start.

`@btravstack/testing`'s `SubmittedUnit.signal` is now available
synchronously after `submit()` whether or not a unit module is in play.
