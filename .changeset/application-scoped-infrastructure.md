---
"@btravstack/di": minor
"@btravstack/core": minor
"@btravstack/orpc-server": minor
"@btravstack/graphql-server": minor
"@btravstack/amqp-worker": minor
"@btravstack/temporal-worker": minor
---

Application infrastructure now reaches request and job units with no forwarding. A module's `needs` list is optional: without it, what a module owes is inferred from its providers' `inject` records and its imports, and a root that leaves a port unsupplied is refused at `start`, naming the port. A `needs` list still states and checks an explicit boundary. A unit module reads whatever the application root provides, so the root no longer exports `Logger`, a database client or a configuration port for a unit's sake.

Two placement rules are now enforced. A unit module that reads `Env` is refused at `start` (`UNIT READS CONFIGURATION — Env is application-scoped`), so configuration is parsed once, at boot. A unit module that provides a port the application scope already provides is refused (at boot for the modules a runtime lists, at the fork otherwise), since each unit would rebuild it; adding a member to one of the application's set ports stays allowed. The migration guide is the new how-to, _Share application infrastructure with units_.

The bare starters are no longer public. `http` (`@btravstack/orpc-server`), `httpServer` (`@btravstack/http-server`), `amqp` and `temporal` left the packages' entry points, so a deployment root is always `HttpModule`, `GraphqlModule`, `AmqpModule` or `TemporalModule`. Each of those exports its runtime port for `start` to read, so no application writes that export by hand. A root that imported a bare starter becomes the matching module sugar, with the router, handlers or activities passed as its option.
