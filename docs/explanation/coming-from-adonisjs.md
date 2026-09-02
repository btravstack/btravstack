---
title: Coming from AdonisJS
description: "The three things that look like they map and do not — providers, models, and the router file — plus what has no equivalent: no ace, no Lucid, no Bouncer, and no scheduler."
---

# Coming from AdonisJS

> **Explanation.** AdonisJS is a full-stack framework with a database layer, a
> CLI, an auth module and a view engine. This one is a kernel plus starters and
> has none of those. The useful half of this page is therefore what does
> **not** map. For the design, start with
> [Why btravstack?](/explanation/why-btravstack).

Adonis gives you a working application on day one; the parts arrive together
and agree with each other. This framework gives you a lifecycle, a container
the compiler checks, and starters for transports — the database layer, the
authentication policy and the views are yours to choose. That is the trade in
one line, and everything below is a consequence of it.

## Three things that look like they map

These are the ones worth reading carefully, because a word means something
different on each side.

### "Provider" is not a provider

An Adonis **provider** is a lifecycle hook on the application container:
`register()`, `boot()`, `start()`, `ready()`, `shutdown()`, registered in
`adonisrc.ts` and often reaching into `app.container.singleton(...)`.

Here a **provider** is one binding: how a single port's service is built,
declared as a value and composed into a module. It has no lifecycle methods —
what an Adonis provider's `shutdown()` does is a resourceful provider's
`release`, which the scope runs on every exit path, and what its `boot()` does
is usually just… construction, because a provider is only built when something
needs it.

The container-registration half has no equivalent at all: there is no
`app.container.bind`, no string keys and no service locator to reach into. If a
piece of code needs a service, it declares it in `inject` and receives it.

### There is no Lucid, and no model layer

`BaseModel`, `@column`, `.find()`, `.related()`, `.preload()`, migrations
through `ace`, factories and seeders — none of it exists here, and no
replacement ships. Persistence is a **port your application declares** and an
adapter you write, usually over Prisma
([`@btravstack/prisma`](/reference/prisma) is the starter that binds one from
`DATABASE_URL` and closes the pool with the scope).

What that costs and buys is worth being blunt about. It costs you the fastest
path from an idea to a table — an Adonis model with two decorators is doing
work you will write by hand. It buys you a domain layer that does not import
the database: `OrderRepository` is your vocabulary, the Prisma client sits
behind it, and swapping the adapter is composing a different module rather than
a migration of every call site.

### The router is not a file

`start/routes.ts` — `router.get('/orders', [OrdersController, 'index'])` — is
Adonis's map of URLs to controllers, edited by hand.

Here the **contract is the map**, and it is a value in its own package: an oRPC
contract declares each procedure's input, output and errors, the router
implements it, and the compiler refuses an implementation that does not match.
Nothing routes by string at runtime, and the client imports the same contract
and gets the call signatures for free — which is the reason the contract lives
in a package a client can take without the server.

The shape that carries over is the controller: a slice owns
`api.OrpcController(contract, "orders")`, which is one contract key's
implementation as a provider. See
[Split a router into controllers](/how-to/split-a-router-into-controllers).

## What has no equivalent

### No `ace`, no scaffolding, no `node ace make:controller`

There is no CLI. A slice is a handful of files you write, and there is no
generator for them yet. The honest statement of the gap: for a first
application this is real friction, and it is
[an open question](https://github.com/btravstack/btravstack/issues/59) rather
than a settled non-goal.

### No Bouncer, no policies, no `@can`

Authentication is a starter concern — a contract marks which security schemes a
procedure accepts, and the application binds an authenticator per scheme, so a
**scope** on the credential is checked before dispatch. _Authorization_ — "may
this caller read this order" — is a call in your handler against your own
rules. There is no policy class, no ability registry and no template directive.

See [Protect a procedure](/how-to/protect-a-procedure).

### No Edge, no views, no i18n

The HTML story here is htmx fragments over an `Html` value that escapes by
default — enough for a server-rendered page, and nothing like a view layer.
There is no template inheritance, no components, no `@each`, and no translation
files. A rendering library is yours to choose, and it composes as an ordinary
provider.

### No scheduler

Adonis reaches for a scheduler package and a cron expression. Here scheduled
work is [Temporal](/reference/temporal-worker)'s — a Schedule with retries, a
history, and a run that happens once across replicas rather than once per
replica. It is a heavier answer and a more honest one at three replicas.

### One runtime per process

An Adonis application serves HTTP, and a queue worker is `node ace queue:work`
beside it. Here each is a **deployment of the same image booting a different
runtime**, and a graph holds exactly one. Three transports means three
processes that scale and fail independently. See
[One process, one runtime](/explanation/one-process-one-runtime).

### Exceptions are not the error channel

Adonis's exception handler turns a thrown error into a response, and
`@adonisjs/core/exceptions` gives you HTTP-shaped ones to throw. Here a failure
is a **value**: a `Result` whose error type the compiler tracks, mapped to a
status exactly once, in the router's triage. A `throw` is a defect — reported,
never routed. See [Nothing throws](/explanation/nothing-throws).

## What AdonisJS does better

**Time to a working application.** Everything agrees with everything, the CLI
writes the boilerplate, and the database layer is right there. For a solo
project that ships this month, that is a serious advantage.

**Batteries.** Auth, validation, mail, views, queues, tests and the CLI, all
one team's decisions. Here you assemble that from starters and libraries, and
some of those choices are still yours to make.

## Where to go next

- The tutorial, which is about an hour:
  [Getting started](/tutorial/getting-started).
- The nearest architectural neighbour:
  [Coming from Spring Boot](/explanation/coming-from-spring-boot).
- What the container refuses to let you get wrong:
  [Compile errors, not surprises](/explanation/compile-time-wiring).
