# Examples

Three small packages, each showing a different job `@btravstack/di` does —
and, at the same time, exercising the library end to end from a consumer's
own workspace, `workspace:*` and all.

| Package                                        | Shows                                                                                                                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`hexagonal-order-api`](./hexagonal-order-api) | The core story: ports named by the application, a private internal beside a public surface, and one application module composed against a production adapter and an in-memory one. |
| [`request-scope`](./request-scope)             | Lifetime management: a pool acquired once under `Module.scoped`, and a `Module.forkScope`'d transaction per request over the built parent.                                         |
| [`plugin-registry`](./plugin-registry)         | Multi-binding: a `Port.many` set port fed by contributions from two independent modules, collected and run together.                                                               |

Unlike the walkthrough in the package README, **this code compiles and is
covered by tests**:

```sh
pnpm install
pnpm test        # every example's specs, alongside the library's own
pnpm typecheck    # includes the compile-time-only guarantees pinned with @ts-expect-error
```

## Why these are tests, not just illustrations

Each example is written the way a real consumer would use `@btravstack/di` —
`src/index.ts` reads as application code, not as a test fixture — but its
`src/index.spec.ts` asserts real behaviour: values returned through a use
case, the exact order resources release in, contributions actually
accumulating. Where a guarantee is compile-time only — an unexported port is
unnameable outside its module, a resourceful graph cannot be built with
`Module.build` — the assertion is a `@ts-expect-error` instead, kept in its
own `*.test-d.ts` file so proving it never requires executing something that
would either assert a falsehood (the built context genuinely is flat, so the
"private" port really is in it at runtime) or leak a resource nothing would
release (calling `Module.build` for real on a graph that needs a scope).
See `hexagonal-order-api/src/index.test-d.ts` for the one example that needs
this.

Nothing here is published: every package is `"private": true`, depends on
`@btravstack/di` via `workspace:*`, and declares `unthrown` itself —
`unthrown` is a peer dependency of the library, not a transitive one, so
every consumer (these examples included) installs it directly.
