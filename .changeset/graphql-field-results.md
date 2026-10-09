---
"@btravstack/graphql-server": minor
---

`fieldResult(result)` answers a resolver from an `AsyncResult<T, GraphQLError>`:
the value, a refusal reported on the field's own path while siblings resolve,
or a masked defect. A masked defect is now reported to `Observers`, where it
used to be recorded nowhere. `plugins` accepts a plugin typed by the context it
reads, checked against the `GraphqlContext` the call builds. `@btravstack/core`
is a new required peer.
