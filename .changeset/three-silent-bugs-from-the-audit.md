---
"@btravstack/di": minor
"@btravstack/http-server": minor
"@btravstack/temporal-worker": minor
---

Closed the three open bugs from the 2026-09-16 audit. Each was silent: a
wiring mistake that compiled, a metric that reported success, and a deploy
that reported it had updated a schedule it had not.

**Two distinct port classes sharing one id is a `WiringDefect` at plan, not a
development-only warning.** Runtime identity is the id string, so a provider
registered against one class silently answered a dependant holding the other —
two packages each declaring `Port("Logger")`, or two copies of one package in
one graph. `port.ts`'s `console.warn` is per module instance and skipped under
`NODE_ENV=production`, which is exactly the case it could not see. The check
walks every `deps` entry as well as every `provides`, because the dependency
side is where the silent read happens, and it runs **after** the
duplicate-provider check: a piece-mint helper (`api.HtmxGet(path)`,
`api.OrpcController(contract, key)`) returns a fresh class per call and relies
on the shared id to make two pieces at one path a duplicate provider, which is
the diagnostic a slice author can act on. The old
`"registered as both a set port and an ordinary port"` message is gone —
`many` is read off the class, so that conflict is always two classes and this
check names the cause instead.

**A client-aborted HTTP request no longer records `ok 200`.**
`ServerResponse.statusCode` defaults to `200` and nothing rewrites it when a
socket dies, so a caller who walked away mid-body, and a `text/event-stream`
the drain reset, both landed in the successes. The outcome now reads
`response.writableFinished`, and `aborted` joins `method`/`answerer`/`status`
as a fourth dimension — a boolean, so the cardinality argument for the other
three is untouched — which is what separates a deploy's own stream resets from
a genuine `500`.

**An inbound `x-request-id` is adopted only if it matches `/^[\w.-]{1,128}$/`.**
It was taken trimmed and otherwise unchecked, and it lands on every log line
and every span, so a caller could send a megabyte of it or a newline. The
`traceparent` path already validated; this is the same rule for the other
header, and it subsumes the non-blank check.

**An absolute-form request target routes to its mount.** `GET
http://host/rpc/x`, which some forward proxies send, was split on `?` and
prefix-matched, so it matched no answerer and took the runtime's own `404`.
Routing now reads `URL.parse(request.url, "http://x").pathname` — `URL.parse`
rather than `new URL`, so a target no parser accepts cannot throw out of the
request callback into the kernel's uncaught handler.

**`ensureSchedule` reconciles the action's `workflowType` and `args`, and
`policies`, not `spec` alone.** The rationale for preserving them said the
handle's `update` validates nothing; measured against
`@temporal-contract/client@8.0.0-beta.9`, it validates `action.args[0]` against
the named workflow's input schema and answers `WorkflowValidationError` — which
was already in this function's error union. So the caution bought exactly the
failure it meant to prevent: a deploy that changed the workflow's arguments
answered `"updated"` while the server kept firing the old action. `state` is
still preserved (an operator's pause survives a deploy), and so are `memo`,
`searchAttributes` and the action's optional overrides — rebuilding the action
wholesale means reproducing `create`'s own assembly here, which is a copy that
drifts.
