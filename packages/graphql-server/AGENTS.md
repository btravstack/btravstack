# packages/graphql-server

Read the root `AGENTS.md` and [`../http-server/AGENTS.md`](../http-server/AGENTS.md)
for shared HTTP and authentication decisions. This package owns only the Yoga
answerer. It requires `graphql` and `graphql-yoga`, accepts any `GraphQLSchema`,
and has no oRPC server or Pothos peer. The example's Pothos schema belongs to
`examples/order-graphql-api`, a separate process that calls the order API.
`incoming` is the Node request in resolver context; Yoga reserves `request`
for its Fetch API request. Published Node floor is 22.15 because Yoga's
dependency tree requires it.
`graphql()` disables Yoga's wildcard CORS and console logging defaults,
accepts a deployment CORS policy and Yoga plugins, and checks declared unit
ports against the actual modules in its `units` option. It forks the runtime's
`HttpUnit` record and refuses a differing declaration at boot, passes CORS
preflights and authentication refusals through Yoga's CORS policy, and disposes
Yoga during scope teardown.

**A masked defect is reported to `Observers`, through Yoga's `maskError`.**
Yoga reports what it masks only through its logger, and `graphql()` turns that
logger off, so before #474 a defect reached the client as `Unexpected error.`
and was recorded nowhere. The hook wraps Yoga's own `maskError` and reports
only when it masked something — a `GraphQLError` a resolver raised on purpose
passes through unreported. `Observers` comes from `httpServer()`, which
contributes `noObserverMember`, so the answerer adds no wiring to a root; that
is why `@btravstack/core` is a required peer.

**GraphiQL and introspection are one switch, `GRAPHQL_DEVELOPER_TOOLS`, off
by default** (#481). GraphiQL needs introspection, so two switches would only
add a combination nobody wants, and off by default means production exposes
neither by omission. The variable is read by the answerer's own provider
through `Env`, pinned by `developerTools`, which is why a root providing
`graphql()` declares `needs: [Env]`. Off, introspection is refused by a
validation rule that reads field names only: graphql's
`NoSchemaIntrospectionCustomRule` asserts the schema's class and throws when
the application and Yoga load two copies of `graphql` (measured under vitest),
and its error is Yoga's `createGraphQLError` for the same reason as
`fieldResult`'s. Yoga registers GraphiQL ahead of every plugin, so on a
protected mount the page renders before the refusal; the operations it sends
are authenticated like any other.

**`plugins` is checked per element, because Yoga's `Plugin<C>` is invariant
in `C`** (`onPluginInit` hands a plugin `Plugin<C>[]`). A plugin typed for the
real context therefore never widened to the bare `Plugin` the option used to
take. The option is a union: an inline plugin is contextually typed by the
context this call builds, and a declared one is inferred with its own context
and refused against `PLUGIN CONTEXT MISMATCH` when the call's context lacks
something it reads. The context reaches only Yoga's OPERATION hooks, which run
once the caller is authenticated (`graphql.spec.ts` records them across a
preflight, a refusal and an accepted call); its server hooks run for all three,
so the option types their context `{}` and refuses a plugin claiming more.
A defect's report carries the located error's `originalError`, not the error
itself, because a log line walks `cause` and would otherwise stop at the
location.

**`fieldResult` rebuilds both channels, because Yoga masks by shape.** A
refusal is thrown as a fresh error carrying only its message and
`extensions`: one carrying an `originalError` is what Yoga masks as
unexpected. A defect is thrown wrapped in a plain `Error`, whatever its cause,
since a `GraphQLError` cause would otherwise be exposed as a refusal and never
reported. The refusal is minted with Yoga's `createGraphQLError`, not
`graphql`'s class: the two can be different module instances (measured under
vitest), and Yoga's check is `instanceof` against its own. Its `Promise`
return is the fourth exception root thesis #6 names.

**`fieldResult` maps nothing.** The resolver's triage of `E` into
`GraphQLError`s is the transport's own mapping, as thesis #3 has it for every
transport; `fieldResult` only moves each channel to where GraphQL reads it.
Deriving a mutation's result union from `E` is declined — see
`docs/explanation/deferred-decisions.md`.
