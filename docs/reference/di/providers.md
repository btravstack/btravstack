---
title: Providers
description: "Provider(port)(deps, options) — the five construction arms, the onStart/onStop hooks, the typed port it hands back, Provider.member, and the three channels a provider carries, precisely."
---

# Providers

> **Reference.** A complete, structured description of `Provider`. For the
> reasoning behind the arms and the channels, see
> [Compile errors, not surprises](/explanation/compile-time-wiring); for the
> resourceful arm in practice,
> [Manage a resource's lifetime](/how-to/manage-a-resource). Full signatures:
> [API reference](/api/di/).

A provider binds one port to one concrete construction. It is a description,
not an instance: nothing runs until a module containing it is built.

## `Provider(port)(deps, options)` / `Provider(port)(options)`

```ts
Provider(OrderRepository)([Database], {
  sync: (db) => ({ findById: (id) => db.query(id) }),
});

Provider(AppConfig)({ value: { dbUrl: "postgres://localhost/orders" } }); // no deps
```

| Parameter | Meaning                                                                                                                                                                                                                                  |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deps`    | An array of ports this construction reads. The resolved services are passed to the arm's function (or constructor) **positionally**, and their types are checked against its parameters. Omitting the array is the zero-dependency form. |
| `options` | Exactly one construction arm, plus the optional hooks.                                                                                                                                                                                   |

The dependency array is also what feeds the module's `Needs` channel: every
port listed here must be available where the module is built, or the graph is
rejected — at compile time if the type is missing, as a
[wiring defect](/reference/di/wiring-defects) if a widened type slipped past.

**Return type:** `Provider<InstanceType<P>, E, N> & { readonly port: P }`. The
provider carries the very port class it was declared for, typed — see
[The typed `port`](#the-typed-port) below.

## The construction family

Exactly one arm per provider. The arms are mutually exclusive by construction —
an options literal supplying two arms' keys fails to compile, not merely warns:

| Arm                   | Shape                                                                                              | When                                                                                | `Scope` in `Needs`? |
| --------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------- |
| `value`               | `S`                                                                                                | The service is already at hand — a config object, a constant.                       | No                  |
| `sync`                | `(...deps) => S`                                                                                   | Built synchronously from its dependencies, and cannot fail.                         | No                  |
| `make`                | `(...deps) => Result<S, E> \| AsyncResult<S, E>`                                                   | Built fallibly, possibly asynchronously — a parsed config, a validated client.      | No                  |
| `class`               | `new (...deps) => S`                                                                               | Built by constructing a class, dependencies passed positionally to the constructor. | No                  |
| `acquire` + `release` | `acquire: (...deps) => Result<S, E> \| AsyncResult<S, E>`, `release: (s) => void \| Promise<void>` | A real resource — a connection, a file handle — that must be torn down.             | Yes                 |

Notes per arm:

- **`value`** cannot fail and contributes `never` to the module's error
  channel.
- **`make`**'s error type is inferred from the `Result` it actually returns
  and joins the module's error channel — a failing `make` stops construction
  and surfaces through the entry point's `Result` as an `Err`. A `make` that
  **throws** instead of returning is a defect, not an `Err`.
- **`class`** — the port's service type is the class's **instance** type; the
  constructor's parameters are checked against `deps`.
- **`acquire`/`release`** come as a pair; neither exists without the other.
  `acquire` may fail exactly as `make` may. `release` runs during scope close,
  in reverse acquisition order; a failure in it is reported (see
  [`ScopedOptions`](/reference/di/entry-points#scopedoptions)) and swallowed,
  never rethrown.

## `onStart` / `onStop`

Optional on **every** arm, supplied inline in the same options literal:

```ts
Provider(Cache)([AppConfig], {
  make: (config) => connectCache(config),
  onStart: (cache) => cache.warm(),
  onStop: (cache) => cache.flush(),
});
```

| Hook                                          | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onStart: (service) => void \| Promise<void>` | After the **whole graph** has finished constructing, never while another provider is mid-construction; sequentially, in declaration order. A hook that throws or rejects is a **defect** — the entry point's `use` is skipped, later hooks do not run, and every finaliser already registered still does.                                                                                                                                                                       |
| `onStop: (service) => void \| Promise<void>`  | During teardown, LIFO alongside `release` finalisers. Declaring one puts `Scope` in `Needs` exactly as `acquire` does: it is teardown, and only [`Module.scoped`](/reference/di/entry-points#module-scoped-module-use-options) / [`Module.forkScope`](/reference/di/entry-points#module-forkscope-parent-module-use-options) ever open a scope to run it. Without that rule, a `{ value, onStop }` provider would satisfy `Module.build` and the hook would silently never run. |

Hooks do not reopen arm exclusivity — `{ value, sync, onStart }` is still a
compile error.

## The typed `port`

What `Provider(port)(…)` returns is `Provider<P, E, N> & { readonly port: P }`
— the port class, typed, rides on the provider. It exists for the helpers that
mint a port **and** its provider in one go — `Config.provider("Name")(schema)`,
`HttpRouter(contract)(name)(deps, arm)`, `TemporalActivities(…)`,
`AmqpHandlers(…)` — so the application holds one value and reads the port off
it: `provider.port` is what another provider lists in its `deps`, what a
module lists in `exports`, and what a starter reads the port from.

```ts
const cacheProvider = Provider(Cache)([AppConfig], {
  make: (config) => connectCache(config),
});

const Warmer = Provider(Port("Warmer")<{ readonly go: () => void }>)(
  [cacheProvider.port],
  {
    sync: (cache) => ({ go: () => void cache.warm() }),
  },
);
```

Purely additive: the intersection is still a `Provider<P, E, N>` everywhere
one is expected. Its declared type is a
[`PortClassOf<Id, Service>`](/reference/di/ports#portinstance-id-service-and-portclassof-id-service)
when the port was minted inside a helper, which is what lets a consumer export
such a provider from a package with `declaration: true`.

## `Provider.member(port)(deps, options)`

The multi-binding form: contributes **one member** to a
[set port](/reference/di/ports#port-many-id-member).

```ts
Provider.member(HealthCheck)([Database], {
  sync: (db) => ({ name: "database", run: db.ping }),
});
```

Identical to `Provider(...)` in every respect — same arms, same hooks, same
`deps` checking, same channels, same typed `port` — except the arm constructs
one `Member`, not the port's whole `readonly Member[]`. `Provider.member` on
an ordinary port does not compile: its member shape is `never`, so no arm can
be satisfied. The reverse — `Provider(...)` on a set port — type-checks
against the whole array and lands it as **one member** at runtime; contribute
to a set port through `Provider.member` only.

## The channels

`Provider<P, E, N>` carries three phantom channels, which the containing
module aggregates:

| Channel | Meaning                                                                                                          |
| ------- | ---------------------------------------------------------------------------------------------------------------- |
| `P`     | The port it satisfies — the port's **instance** type.                                                            |
| `E`     | What construction may fail with: `make`/`acquire`'s inferred error, `never` for the other arms.                  |
| `N`     | What it needs: the union of `deps`' instance types, plus `Scope` when the arm is resourceful or `onStop` is set. |

The variance rule (shared with [`Module`](/reference/di/modules#the-channels)):
capability channels are contravariant — you may forget what you have;
obligation channels (`E`, `N`) are covariant — **you may not forget what you
owe**. A type annotation can widen a provider's port, but no annotation can
drop an error case or launder away `Scope`.

## `AnyProvider`

The structural bound every provider satisfies — `{ port: AnyPort; deps:
readonly AnyPort[] }`, channel-free. It is what `Module`'s `provides` is
typed over, and what a package offering a **shaped module** (a starter's
`HttpModule(name)({ router, imports, provides, exports })`) constrains its own
`provides` with before handing the tuple to `Module(name)`.

## Construction semantics

During a build, providers are grouped into dependency levels; providers in the
same level construct **concurrently** (all started before any is awaited),
levels strictly in order. Each provider constructs **once** per build — every
consumer of its port sees the same instance. Declaration order within a level
makes error selection and hook order deterministic: the failure reported is
the first `Err` in declaration order, except that a **defect** anywhere in the
level outranks any `Err`.
