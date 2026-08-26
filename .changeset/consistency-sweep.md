---
"@btravstack/mailer": minor
"@btravstack/di": patch
"@btravstack/prisma": patch
---

Four consistency fixes across the family, found by auditing the thirteen
packages against each other rather than each on its own.

**`@btravstack/mailer`'s telemetry namespace was split down the middle.** The
counter was `btravstack.mailer.sends` while its span attributes were
`btravstack.mail.recipients` / `.subject` — two prefixes for one package.
`cache` and `storage` each use one throughout. It is `mail` now, everywhere:

|            | before                    | after                        |
| ---------- | ------------------------- | ---------------------------- |
| counter    | `btravstack.mailer.sends` | `btravstack.mail.operations` |
| attributes | `{ outcome }`             | `{ operation, outcome }`     |
| span       | `mailer.send`             | `mail.send`                  |

The counter is renamed rather than aliased, and the shape now matches
`cache.operations`, `storage.operations` and `database.operations` — three said
`operations` with an `operation` attribute, one said `sends` with neither, so a
dashboard could not group them. **A dashboard reading the old name needs
updating**; that is the cost of doing it before more people have one.

**`@btravstack/di` had no coverage gate.** Every other published package
enforces 100% lines and functions; the container — the package everything peers
on — was measured at 99.38% lines and 97.18% functions with nothing failing.
It has its own `vitest.config.ts` now, which is what `vitest.shared.ts`'s own
comment says a workspace needing more should do. Three tests close the gap: the
production early-return in the duplicate-port-id warning, `createScope`'s
default teardown reporter, and the nullish guards that read a forged `Context`
as empty. `Context`'s phantom variance marker is `/* v8 ignore */`d, since it is
uncallable by design and the alternative was a weaker gate on the container.

**`@btravstack/prisma` had a type-test gate that checked nothing** — a
`test:types` script and a `tsconfig.test-d.json` with no `*.test-d.ts` file to
run against, so it passed vacuously. It pins six things now, each with mutual
assignability so a needs list that GAINS a port fails too: the port carries the
application's own client type, the port id carries its name, the instrumented
arm needs exactly `Env | Logger | Meter | Tracer`, `instrumented: false` needs
exactly `Env`, the error channel is the config's unwrapped, and a client with no
`$disconnect` is refused.

It also moves to the `exclude` + chained-`tsc` arrangement `core`, `di`,
`http-server`, `amqp-worker` and `temporal-worker` already use, rather than the
one `cache`, `mailer` and `storage` use. Both check the files; only the first
permits `type _X = Expect<…>` aliases, which `noUnusedLocals` rejects under the
second.
