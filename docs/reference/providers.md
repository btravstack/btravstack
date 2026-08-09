---
title: Providers
description: "The construction family — value, sync, make, class, acquire/release — the onStart/onStop hooks, and Provider.member, precisely."
---

# Providers

A provider binds one port to one concrete construction. It is a description,
not an instance: nothing runs until a module containing it is built.

## `Provider(port)(deps, options)` / `Provider(port)(options)`

```ts
Provider(OrderRepository)([Database], {
  sync: (db) => ({ findById: (id) => db.query(id) }),
});

Provider(AppConfig)({ value: { dbUrl: "postgres://localhost/orders" } }); // no deps
```

- **`deps`** — an array of ports this construction reads. The resolved
  services are passed to the arm's function (or constructor) **positionally**,
  and their types are checked against its parameters. Omitting the array is
  the zero-dependency form.
- **`options`** — exactly one construction arm, plus optional hooks.

The dependency array is also what feeds the module's `Needs` channel: every
port listed here must be available where the module is built, or the graph is
rejected — at compile time if the type is missing, as a
[wiring defect](/reference/wiring-defects) if a widened type slipped past.

## The construction family

Exactly one arm per provider. The arms are mutually exclusive by
construction — an options literal supplying two arms' keys fails to compile,
not merely warns:

| Arm                   | Shape                                                                                              | When                                                                                | Puts `Scope` in `Needs`? |
| --------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------ |
| `value`               | `S`                                                                                                | The service is already at hand — a config object, a constant.                       | No                       |
| `sync`                | `(...deps) => S`                                                                                   | Built synchronously from its dependencies, and cannot fail.                         | No                       |
| `make`                | `(...deps) => Result<S, E> \| AsyncResult<S, E>`                                                   | Built fallibly, possibly asynchronously — a parsed config, a validated client.      | No                       |
| `class`               | `new (...deps) => S`                                                                               | Built by constructing a class, dependencies passed positionally to the constructor. | No                       |
| `acquire` + `release` | `acquire: (...deps) => Result<S, E> \| AsyncResult<S, E>`, `release: (s) => void \| Promise<void>` | A real resource — a connection, a file handle — that must be torn down.             | Yes                      |

Notes per arm:

- **`value`** cannot fail and contributes `never` to the module's error
  channel.
- **`make`**'s error type is inferred from the `Result` it actually returns
  and joins the module's error channel — a failing `make` stops construction
  and surfaces through the build call's `Result`.
- **`class`** — the port's service type is the class's **instance** type;
  the constructor's parameters are checked against `deps`.
- **`acquire`/`release`** come as a pair; neither exists without the other.
  `acquire` may fail exactly as `make` may. `release` runs during scope close,
  in reverse acquisition order; a failure in it is reported (see
  [`ScopedOptions`](/reference/entry-points#scopedoptions)) and swallowed,
  never rethrown.

## `onStart` / `onStop`

Optional on **every** arm, supplied inline in the same options literal:

```ts
Provider(Cache)([Config], {
  make: (config) => connectCache(config),
  onStart: (cache) => cache.warm(),
  onStop: (cache) => cache.flush(),
});
```

- **`onStart: (service) => void | Promise<void>`** — fires after the **whole
  graph** has finished constructing, never while another provider is still
  mid-construction. Hooks fire in declaration order. A rejecting `onStart`
  fails the build the same way a failing construction does.
- **`onStop: (service) => void | Promise<void>`** — fires during teardown,
  LIFO alongside `release` finalisers. Declaring one puts `Scope` in `Needs`
  exactly as `acquire` does: it is teardown, and only
  [`Module.scoped`](/reference/entry-points#module-scoped-module-use-options) /
  [`Module.forkScope`](/reference/entry-points#module-forkscope-parent-module-use-options)
  ever open a scope to run it. Without that rule, a `{ value, onStop }`
  provider would satisfy `Module.build` and the hook would silently never run.

Hooks do not reopen arm exclusivity — `{ value, sync, onStart }` is still a
compile error.

## `Provider.member(port)(deps, options)`

The multi-binding form: contributes **one member** to a
[set port](/reference/ports#port-many-id-member).

```ts
Provider.member(HealthCheck)([Database], {
  sync: (db) => ({ name: "database", run: db.ping }),
});
```

Identical to `Provider(...)` in every respect — same arms, same hooks, same
`deps` checking, same channels — except the arm constructs one `Member`, not
the port's whole `readonly Member[]`. Using `Provider` on a set port, or
`Provider.member` on an ordinary one, does not compile.

## The channels

`Provider<P, E, N>` carries three phantom channels, which the containing
module aggregates:

- **`P`** — the port it satisfies.
- **`E`** — what construction may fail with: `make`/`acquire`'s inferred
  error, `never` for the other arms.
- **`N`** — what it needs: the union of `deps`' instance types, plus `Scope`
  when the arm is resourceful or an `onStop` is present.

The variance rule (shared with [`Module`](/reference/modules#the-channels)):
capability channels are contravariant — you may forget what you have;
obligation channels (`E`, `N`) are covariant — **you may not forget what you
owe**. A type annotation can widen a provider's port, but no annotation can
drop an error case or launder away `Scope`.

## Construction semantics

During a build, providers are grouped into dependency levels; providers in
the same level construct **concurrently** (all started before any is
awaited), levels strictly in order. Each provider constructs **once** per
build — every consumer of its port sees the same instance. Declaration order
within a level makes error selection and hook order deterministic.
