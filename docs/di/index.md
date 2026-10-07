---
layout: home
title: di — type-safe dependency injection for TypeScript
description: A standalone module-based dependency-injection container. Define ports and providers, keep module internals private, and catch missing wiring at compile time.

hero:
  name: "di"
  text: "Wiring checked by TypeScript"
  tagline: Define the capabilities your application needs, bind them at one edge, and compose modules whose missing dependencies are compile errors.
  image:
    light: /di/logo-light.svg
    dark: /di/logo-dark.svg
    alt: di beetroot logo
  actions:
    - theme: brand
      text: Get Started
      link: /di/tutorial/getting-started
    - theme: alt
      text: Reference
      link: /reference/di/ports
    - theme: alt
      text: GitHub
      link: https://github.com/btravstack/btravstack

features:
  - title: Ports belong to your application
    details: Name a dependency for what your code needs, not for the database or service that provides it.
  - title: Missing wiring is a compile error
    details: Providers declare their dependencies; modules declare what they export and expect from outside.
  - title: Internals stay private
    details: A module exports selected ports while keeping its other providers unavailable to consumers.
  - title: Resources close with the scope
    details: Module.scoped builds a graph, runs your work, and releases acquired resources on every exit path.
---

## Use di on its own

`@btravstack/di` works without the btravstack application kernel or a server
runtime. Install the container and its `unthrown` peer dependency:

```sh
pnpm add @btravstack/di unthrown
```

A [port](/reference/di/ports) names a capability in your application's
vocabulary. A [provider](/reference/di/providers) constructs it, and a
[module](/reference/di/modules) chooses which ports the rest of the
application can see. [`Module.scoped`](/reference/di/entry-points#module-scoped-module-use-options)
builds the graph, runs work with its typed context, and closes the scope.

The [DI tutorial](/di/tutorial/getting-started) starts from an empty TypeScript
project. For a larger application with production and in-memory adapters, see
the [hexagonal example](/examples/di-hexagonal). The complete exported surface
is in the [API reference](/api/di/).
