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
