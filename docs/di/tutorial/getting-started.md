---
title: Getting started with di
description: Build a small TypeScript application with a port, provider, and module, then run and close it with Module.scoped.
---

# Getting started with di

> **Tutorial.** Start with an empty TypeScript project, define one capability,
> provide it, and run it through a module. This uses `@btravstack/di` on its
> own; no framework runtime or HTTP server is involved.

## Install

In a new project with Node.js 22.6 or later (for the built-in TypeScript runner):

```sh
mkdir di-hello
cd di-hello
pnpm init
pnpm add @btravstack/di unthrown
pnpm add -D typescript @types/node
```

Set `"type": "module"` in `package.json`. Create `tsconfig.json` with strict
NodeNext resolution:

```json
{
  "compilerOptions": {
    "strict": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "noEmit": true
  }
}
```

## Define and run a module

Create `index.ts`:

```ts
import { Module, Port, Provider } from "@btravstack/di";
import { OkAsync, type AsyncResult } from "unthrown";

class Greeting extends Port("Greeting")<{
  readonly greet: (name: string) => AsyncResult<string, never>;
}> {}

const greeting = Provider(Greeting)({
  inject: {},
  sync: () => ({ greet: (name) => OkAsync(`Hello, ${name}!`) }),
});

const App = Module("App")({
  provides: [greeting],
  exports: [Greeting],
});

const result = await Module.scoped(App, (ctx) => ctx.get(Greeting).greet("Ada"));
if (result.isOk()) console.log(result.value);
else console.error(result);
```

Run `pnpm exec tsc --noEmit` to check the wiring, then
`node --experimental-strip-types index.ts` to print `Hello, Ada!`. Node
strips the types to run this example; it does not check them, so keep the
`tsc` step.

`Greeting` is a [port](/reference/di/ports): the application names what it
needs. `greeting` is a [provider](/reference/di/providers): its `inject`
record declares its dependencies, empty in this example. `App`
[exports](/reference/di/modules) only the port a caller may use.
[`Module.scoped`](/reference/di/entry-points#module-scoped-module-use-options)
hands that port to the callback through a typed context and closes the scope
before its result settles. The result is a value you inspect; a modeled
failure would travel in its error channel.

Try removing `greeting` from `provides`. TypeScript refuses to export
`Greeting`, because no provider backs it. Put it back before running the
example.

Next, explore [provider construction and resources](/reference/di/providers),
[read a wiring defect](/reference/di/wiring-defects), and the
[hexagonal example](/examples/di-hexagonal), which swaps a production adapter
for an in-memory one without changing the application module.
