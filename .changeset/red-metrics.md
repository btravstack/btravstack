---
"@btravstack/http-server": minor
"@btravstack/temporal-worker": minor
"@btravstack/amqp-worker": minor
---

The three servers record RED metrics. Each runtime now counts and times its own
unit — `btravstack.http.{requests,duration}` by method, answerer and status;
`btravstack.amqp.{deliveries,duration}` by handler and outcome;
`btravstack.temporal.activity.{attempts,duration}` by activity and outcome — on
the `Meter` port, on by default.

**Breaking for a root that composes no OTel SDK**: `instrumented` defaults to
`true`, which puts `Meter` in the starter's needs. Pass `instrumented: false` to
drop it — no meter, no instrument built, and no clock read on the hot path.

A `minor` rather than a `major` because the line is still `0.x`, where changesets
turns a major into `1.0.0` for the whole fixed group. Reaching `1.0.0` is a
decision here rather than a side effect of a breaking change, which
`.changeset/CLAUDE.md` records.
