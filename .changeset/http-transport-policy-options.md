---
"@btravstack/amqp-worker": minor
"@btravstack/cache": minor
"@btravstack/config": minor
"@btravstack/contract": minor
"@btravstack/core": minor
"@btravstack/di": minor
"@btravstack/http-server": minor
"@btravstack/mailer": minor
"@btravstack/observability": minor
"@btravstack/prisma": minor
"@btravstack/storage": minor
"@btravstack/temporal-worker": minor
"@btravstack/testing": minor
---

CORS, body limits and response compression are options on `http()` and
`HttpModule` rather than `plugins` lines — and every framework scalar a
deployment could reasonably vary is now a configuration field, pinned by its
option.

```ts
export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  cors: { origin: "https://orders.example", credentials: true },
  bodyLimit: 5_000_000,
  compression: true,
});
```

`true` takes the underlying oRPC plugin's own defaults; a record is that
plugin's own options type verbatim — `CORSHandlerPluginOptions`,
`ResponseCompressionHandlerPluginOptions` — never a `Record<string, unknown>`
bag. `plugins` stays for every oRPC plugin these three do not name.

## Eight new variables, each pinned by its option

The option is what a test or a settled decision fixes; the variable is what a
deployment sets. `Config.pinned` decides between them per field — explicit
beats environment beats default — exactly as `PORT` and `HOST` already worked.

| Variable                                               | Default           | Bound by                                  |
| ------------------------------------------------------ | ----------------- | ----------------------------------------- |
| `PRE_DRAIN_DELAY_MS` / `DRAIN_TIMEOUT_MS`              | `5000` / `20000`  | the kernel                                |
| `HTTP_BODY_LIMIT`                                      | `1048576`         | `http()` — `0` is unbounded               |
| `HTTP_CORS_ORIGIN`                                     | unset (off)       | `http()` — a comma-separated list, or `*` |
| `HTTP_COMPRESSION`                                     | `false`           | `http()`                                  |
| `TEMPORAL_GRACE_PERIOD_MS` / `TEMPORAL_FORCE_AFTER_MS` | `10000` / `15000` | `temporal()`                              |
| `AMQP_CONNECT_TIMEOUT_MS`                              | `5000`            | `amqp()`                                  |

The drain timings are the reason this shape matters: they have to agree with
the pod's `terminationGracePeriodSeconds`, which lives in the manifest — so
they belong beside it rather than compiled into the image. The same is true of
a CORS origin, a body limit and Temporal's shutdown budget.

**Every variable carries its starter's prefix** — `HTTP_`, `TEMPORAL_`, `AMQP_`,
`STORAGE_S3_` — because several starters share one process, and a bare
`BODY_LIMIT` is a name the next starter would also want. The exceptions are
names the ecosystem already owns and a platform injects (`PORT`, `HOST`,
`DATABASE_URL`, `REDIS_URL`, `SMTP_URL`, `LOG_LEVEL`), plus the kernel's own
three, since a process has exactly one kernel.

`@btravstack/config` gains **`Config.boolean`** for the flags: `true`/`false`,
`1`/`0`, `yes`/`no`, `on`/`off`, case-insensitive. Anything else is an error
rather than a falsy reading — a deployment that wrote `HTTP_COMPRESSION=enabled`
meant to turn it on.

Three things stay composition-time on purpose: a **shape** (`plugins`, a CORS
record's allowed headers), because an environment carries strings; a **graph
decision** (`instrumented`), because it changes what is built; and
`securityHeaders`, because a deployment that can silently turn
`x-frame-options` off is a footgun the other policies are not.

## Consequences

- `HttpConfig` is `{ port, hostname, bodyLimit, corsOrigin, compression }`,
  `TemporalConfig` gains `{ gracePeriodMs, forceAfterMs }`, and `AmqpConfig`
  gains `{ connectTimeoutMs }`. Anything in the graph may read them.
- **`AMQP_CONNECT_TIMEOUT_MS` defaults to 5 s where the library defaults to
  30**: thirty seconds is longer than most orchestrators wait before
  restarting the pod, so an unreachable broker is now reported rather than sat
  on.
- A malformed `PROBE_PORT`, `PRE_DRAIN_DELAY_MS` or `DRAIN_TIMEOUT_MS` is one
  `RuntimeStartFailed` with `runtime: "kernel"` (it was `"probes"`) whose
  `ConfigInvalid` names **every** variable that was wrong — one round trip for
  the operator. A probe _bind_ failure is still `runtime: "probes"`.
- `HttpOptions`, `TemporalTuning` and `AmqpTuning` are each spelled once and
  intersected into the module sugar's options, which now forwards the whole
  record instead of field by field. An option the sugar forgets to forward can
  no longer exist — which is what this issue was about.

## `bodyLimit` defaults on, and the other two default off

An unbounded body is a trust boundary, where CORS and compression are policy a
framework guessing is worse than one staying quiet. Over the limit is oRPC's
`PAYLOAD_TOO_LARGE`, decided on `content-length` when one is sent and while
streaming otherwise. `bodyLimit: false` — or `BODY_LIMIT=0` — is the previous
unbounded behaviour.

`compression` is the **response** half. Request decompression stays a
`plugins` line: inflating a body before the limit measures it is a decision an
application should make in the open.

**CSRF stays a `plugins` line, and the claim was narrowed to say so.**
`packages/http-server/CLAUDE.md` stated CORS, body limits, compression, CSRF,
security headers and authentication were all "handler configuration, not a
middleware slot" while the code shipped that for two of the six. oRPC's CSRF
protection only bites on a request carrying a `SameSite` cookie, and this
package configures no cookies, so it becomes an option when they arrive.
