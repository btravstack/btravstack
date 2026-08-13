---
title: Examples
description: Three runnable workspace packages — a hexagonal slice, per-request lifetimes, and a plugin registry — each compiled and spec-covered in CI.
---

# Examples

Three small packages under
[`examples/`](https://github.com/btravstack/di/tree/main/examples), each
showing a different job `@btravstack/di` does — and, at the same time,
exercising the library end to end from a consumer's own workspace.

| Package                                              | Shows                                                                                                                                                                              |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Hexagonal order API](/examples/hexagonal-order-api) | The core story: ports named by the application, a private internal beside a public surface, and one application module composed against a production adapter and an in-memory one. |
| [Request scope](/examples/request-scope)             | Lifetime management: a pool acquired once under `Module.scoped`, and a `Module.forkScope`'d transaction per request over the built parent.                                         |
| [Plugin registry](/examples/plugin-registry)         | Multi-binding: a `Port.many` set port fed by contributions from two independent modules, collected and run together.                                                               |

## Why these are tests, not just illustrations

Unlike the fenced snippets in the guide, **this code compiles and its specs
run in CI**. Each `src/index.ts` reads as application code, not as a test
fixture — but its `src/index.spec.ts` asserts real behaviour: values returned
through a use case, the exact order resources release in, contributions
actually accumulating.

Where a guarantee is compile-time only — an unexported port is unnameable
outside its module, a resourceful graph cannot be built with `Module.build` —
the assertion is a `@ts-expect-error` in a `*.test-d.ts` file instead. Proving
those at runtime would mean either asserting a falsehood (the built context
genuinely is [flat](/explanation/modules-and-privacy), so the "private" port
really is in it) or leaking a resource nothing would release (calling
`Module.build` for real on a graph that needs a scope).

Nothing here is published: every package is private, depends on
`@btravstack/di` via `workspace:*`, and declares `unthrown` itself — a
[peer dependency](/explanation/peer-dependencies) is the consumer's to
install, and these packages are consumers.

## Running them

```sh
git clone https://github.com/btravstack/di.git && cd di
pnpm install
pnpm test        # every example's specs, alongside the library's own
pnpm typecheck   # includes the @ts-expect-error assertions
```
