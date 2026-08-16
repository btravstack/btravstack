# @btravstack/testing

> Test the applications [`@btravstack/core`](../core) boots. A `test.extend`
> fixture that starts a module with a test's defaults and stops every app it
> started when the test ends, a tap that hands back the very services a booted
> graph holds, an in-memory runtime, a clock that moves on demand — the way
> `@nestjs/testing` is to NestJS, and kept out of the kernel so a production
> bundle never pulls the fakes in.

📖 **[Documentation](https://btravstack.github.io/start/how-to/test-an-application)** ·
[Reference](https://btravstack.github.io/start/reference/testing) ·
[API Reference](https://btravstack.github.io/start/api/testing/)

```sh
pnpm add -D @btravstack/testing @btravstack/core @btravstack/config @btravstack/di unthrown
```

`@btravstack/core`, `@btravstack/config`, `@btravstack/di` and `unthrown` are
peer dependencies; the package depends on nothing else — not even `vitest`:
`bootFixture` is a plain `(ctx, use) => Promise<void>` function, which is
vitest's fixture protocol, so no import is needed to hand it to `test.extend`.
Node `>=20`. Not yet published: this repository has not cut a release yet.

## A booted application, as a fixture

```ts
import { bootFixture, tapped, type Boot } from "@btravstack/testing";
import { expect, test } from "vitest";

const it = test.extend<{ boot: Boot }>({
  boot: bootFixture({ env: { PORT: "0", HOST: "127.0.0.1" } }),
});

it("serves on an ephemeral port", async ({ boot }) => {
  const app = boot(OrderApi, { unit: RequestModule });

  await expect(app.runtimeInfo()).toBeOkWith(
    expect.objectContaining({ port: expect.any(Number) }),
  );
});

it("holds the very logger the use cases write to", async ({ boot }) => {
  const tap = tapped(OrderApi, [Logger]);
  await boot(tap.module, { unit: RequestModule }).runtimeInfo();

  const [logger] = tap.services();
  expect(logger.lines()).toEqual([]);
});
```

`boot` is `start` as a test hands it out: the same signature, the same
compile-time gate, minus `signals` — always off — with `probes: false` unless
a call asks for a port, `preDrainDelayMs: 0` and a silent `onEvent` as
defaults, each overridable by the fixture's `defaults` and again per call.
When the test ends every app it started is stopped, on every exit path, a
failing assertion included; a **`Defect`** on `exited` fails the test even
when the test never looked at it, while a modeled `Err` — a startup failure
the test may be asserting — passes through.

`tapped(module, [Port, …])` composes one more provider around `module`,
depending on those ports, and remembers what it was built with: `services()`
answers the very instances the running graph holds once it is built — after
`runtimeInfo()` resolves, say — and throws before. The gate refuses a port
`module` does not export.

## What it ships

- **`bootFixture(defaults?)`** — the fixture above; `Boot` and `BootDefaults`
  are its types.
- **`tapped(module, ports)`** → `{ module, services() }` — read services out
  of a booted application.
- **`testRuntime(name?)`** / **`TestRuntimePort`** — an in-memory `Runtime`
  with `submit()` to hold a unit open across a drain, and a `module` that
  provides it where a starter would.
- **`createFakeClock(start?)`** — a `Clock` for `StartOptions.clock` whose
  time moves only on `advance(ms)`.

The teardown rule: a `Defect` on `exited` fails the test, a modeled `Err` does
not.

## License

[MIT](./LICENSE) © Benoit TRAVERS
