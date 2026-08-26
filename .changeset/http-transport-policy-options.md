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
`HttpModule` rather than `plugins` lines.

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

**`bodyLimit` defaults to 1 MiB, where the other two default off**, and the
asymmetry is the point: an unbounded body is a trust boundary, where CORS and
compression are policy a framework guessing is worse than one staying quiet.
Over the limit is oRPC's `PAYLOAD_TOO_LARGE`, decided on `content-length` when
one is sent and while streaming otherwise. An application serving uploads
raises it; `false` is the previous unbounded behaviour.

`compression` is the **response** half. Request decompression stays a
`plugins` line: inflating a body before the limit measures it is a decision an
application should make in the open.

**CSRF stays a `plugins` line, and the claim was narrowed to say so.**
`packages/http-server/CLAUDE.md` stated CORS, body limits, compression, CSRF,
security headers and authentication were all "handler configuration, not a
middleware slot" while the code shipped that for two of the six. Five are now
options; oRPC's CSRF protection only bites on a request carrying a `SameSite`
cookie, and this package configures no cookies, so it becomes an option when
they arrive.
