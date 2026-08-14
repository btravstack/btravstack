# @btravstack/config

Configuration parsed from the environment, wired through
[`@btravstack/di`](https://github.com/btravstack/di) as an ordinary port and
adapter.

A starter declares a **port** the normal way — `Port(id)<Service>` — and
`Config(port, prefix)(shape)` is one **adapter** for it: a di module that
implements the port by parsing `prefix`-scoped environment variables. The
port stays a port: a test can hand it a literal, and a future file or
secret-manager source can be a different adapter for the same port. Neither
is possible when the port and its environment parser are welded into one
value — this package deliberately keeps them apart.

## Declaring a port and its env adapter

```ts
import { Config, type ValueOf } from "@btravstack/config";
import { Port } from "@btravstack/di";
import { z } from "zod";

const shape = {
  url: z.string().min(1).default("amqp://127.0.0.1:5672"),
  prefetch: z.string().min(1).pipe(z.coerce.number<string>().int()).default(10),
};
export class AmqpConfig extends Port("AmqpConfig")<ValueOf<typeof shape>> {}
export const AmqpConfigFromEnv = Config(AmqpConfig, "AMQP")(shape);
```

Each value in `shape` is a [Standard Schema](https://standardschema.dev)
validator — a `zod` schema above, but any Standard-Schema-compliant library
works. `ValueOf<typeof shape>` types the port from the shape, so the service
type and the schema are never written twice. A starter ships the port and
its env adapter together, alongside the properties it defines: the shape and
the defaults live with the code that gives them meaning, not in a central
file every consumer has to know about.

The port is declared by the starter, not by `Config`, because that is what
makes it adaptable: `Config(port, prefix)(shape)` is just one provider for
`port`, on equal footing with any other. An application imports the env
adapter; a test imports nothing from this package at all:

```ts
// the application
import { Module } from "@btravstack/di";
import { OkAsync } from "unthrown";

const App = Module("App")({
  imports: [
    ApplicationModule,
    PersistenceModule,
    AmqpConfigFromEnv,
    Config.source({ AMQP_URL: "amqp://broker" }),
  ],
  exports: [AmqpConfig],
});

const value = await Module.scoped(App, (ctx) => OkAsync(ctx.get(AmqpConfig)));
// Ok({ url: "amqp://broker", prefetch: 10 })
```

```ts
// a test, or any other adapter — ordinary di, no config involvement
import { Module, Provider } from "@btravstack/di";

const Test = Module("Test")({
  provides: [
    Provider(AmqpConfig)({ value: { url: "amqp://fake", prefetch: 1 } }),
  ],
  exports: [AmqpConfig],
});
```

`imports: [AmqpConfigFromEnv]` provides the port; `ctx.get(AmqpConfig)` reads
it back — from either adapter, unchanged. An adapter imported by two
different modules in the same graph is still parsed once — di dedupes the
module before its provider ever runs.

`Config(port, prefix)(shape)` also enforces, at compile time, that `shape`
actually implements `port`: `shape`'s parsed output must be assignable to
`port`'s own service type. A shape missing a key the port declares, or with
the wrong type for one, fails to compile — the same way a wrong `Provider`
qualification would.

## Naming: camelCase in, `PREFIX_SCREAMING_SNAKE` out

Each key of the shape maps to an environment variable named by the adapter's
prefix and the key shouted: `url` under `Config(port, "AMQP")` reads
`AMQP_URL`; `prefetch` reads `AMQP_PREFETCH`. The rule is a straight case
conversion — the key's own camelCase word boundaries become underscores — so
a validator's keys can stay idiomatic TypeScript while the environment stays
idiomatic shell. A multi-word key splits at every boundary: `prefetchCount`
under `Config(port, "AMQP")` reads `AMQP_PREFETCH_COUNT`. An acronym run is
left alone, not split letter-by-letter: `urlBase` reads `URL_BASE`, but
`URLBase` — the acronym already shouted in the key itself — reads `URLBASE`.

## `Config.source`: the environment as a port

Env adapters don't read `process.env` directly. `Config.source(record)` is
the module that provides `ConfigSource` — the one place a plain
`Record<string, string | undefined>` enters the graph:

```ts
Config.source(process.env);
```

The environment is a port, not an ambient read, so that validating the
configuration and actually providing it can never disagree about what the
environment was. If an adapter read `process.env` itself while validation
read a snapshot taken earlier, the two could see different values — a
variable set between the two reads would pass validation and then fail to
inject, or the reverse. Threading one `ConfigSource` through both removes the
seam where that mismatch could happen.

## Validating everything before boot: `Config.collect` and `Config.parse`

`Config.collect(module)` walks a module tree and returns every env adapter
reachable from it, each once, regardless of how many times or how deep it is
imported:

```ts
const adapters = Config.collect(App);
```

`Config.parse(adapters, source)` validates all of them against one source
and aggregates every issue — from every adapter — into a single
`ConfigInvalid`:

```ts
const outcome = Config.parse(adapters, process.env);
```

`outcome` is `Ok()` when every adapter agrees with the environment, or an
`Err` carrying one `ConfigInvalid` — `{ issues: [{ variable, message }, ...] }`
— when any of them don't. This is the one-report guarantee: `Config.parse`
does not stop at the first wrong variable. An operator who mistyped three
environment variables learns about all three from one failed boot, not one
deploy per fix. `describeIssues` formats the issues as one line each,
`"  VARIABLE: message"`, joined for a log or an exit message:

```ts
import { describeIssues } from "@btravstack/config";

if (outcome.isErr()) {
  console.error(describeIssues(outcome.error.issues));
}
```

`Config.collect` walks the **root** module tree only. An adapter reachable
exclusively through a `Module.forkScope` request module — one built fresh per
request, layered over an already-built parent `Context` — is not part of that
tree and is therefore not covered by this pre-boot validation pass. That gap
is a deliberate phase-2 design decision (`@btravstack/start-core` owns when
and how forked request modules get validated), not something this package
solves; an adapter declared only inside a request module today is still
parsed by its own provider, just without the one-report-before-boot
guarantee.

## `@btravstack/config/zod`: `wholeNumber` and `port`

Two `zod` builders for the coercions configuration validation needs most:

```ts
import { port, wholeNumber } from "@btravstack/config/zod";

const httpShape = {
  port: port(3000),
  maxConnections: wholeNumber(100, 1, 10_000),
};
class HttpConfig extends Port("HttpConfig")<ValueOf<typeof httpShape>> {}
const HttpConfigFromEnv = Config(HttpConfig, "HTTP")(httpShape);
```

`wholeNumber(fallback, min, max)` reads a string, requires it non-empty,
coerces it to an integer, and bounds it — falling back to `fallback` only when
the variable is genuinely absent. The non-empty check in front of the
coercion is load-bearing: `Number("")` is `0`, so a variable set to nothing
(`PORT=`) would otherwise silently become the ephemeral port `0` instead of
raising a configuration error. The bounds alone cannot catch that case,
because for `port` — `wholeNumber(fallback, 0, 65_535)` — `0` is a legitimate
value, not just the coercion of an empty string.

## What's next

Kernel integration — turning a `ConfigInvalid` into process exit code
`EX_CONFIG` and wiring zero-config entry points — arrives in
`@btravstack/start-core` in phase 2. This package only validates and provides;
it never reads `process.env` on its own and it never exits the process.
