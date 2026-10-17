---
name: btravstack
description: Build and change applications on the btravstack framework — di modules and ports, oRPC contracts served by @btravstack/orpc-server, Temporal and AMQP workers, configuration from the environment, and booted tests with @btravstack/testing. Use when the project depends on any @btravstack/* package, when adding a procedure, a slice, a worker or a configuration variable to such a project, when wiring a composition root, or when reading a compile error that carries a marker like UNSATISFIED DEPENDENCIES or UNCOVERED CONTROLLERS.
---

# btravstack

A Node framework where the application is a set of di **modules**, a
**runtime** is composed around them, and the compiler proves the wiring before
a process exists. Business code is plain TypeScript returning `unthrown`
`Result`s; nothing throws, and nothing reads `process.env`.

Errors as values are the `unthrown` skill's subject — install it beside this
one (`npx skills add btravstack/unthrown --skill unthrown`) and follow it for
every `Result`, `TaggedError` and `mapErrCases`.

Full documentation: <https://btravstack.github.io/btravstack/>. This skill is
published from `main`; when it disagrees with the types of the version you have
installed, the installed types win.

## Mental model

- **A port is a name with a service type; a provider builds it; a module says
  what it provides and what it exports.** `Port("Name")<Shape>`,
  `Provider(Port)({ inject, sync })`, `Module("Name")({ imports, provides,
  exports })`, all from `@btravstack/di`.
- **What a module needs is inferred** from what its providers `inject`. Do not
  restate it; write `needs: [...]` only to check a slice's boundary at its own
  declaration.
- **The root of a deployment is a runtime module**: `HttpModule` from
  `@btravstack/orpc-server`, `GraphqlModule`, `McpModule`, `TemporalModule`,
  `AmqpModule`. `main.ts` is one
  line: `await runMain(App)`. `runMain` sets the exit code; never call
  `process.exit`.
- **One process boots exactly one runtime.** An API and a worker are two
  deployments booting the same application modules under different runtimes,
  each with its own `main.ts`.
- **The contract comes first and lives apart from the server**, so a client
  can import it without the implementation.

## Which runtime

| The work is…                                              | Use                                                                     |
| --------------------------------------------------------- | ----------------------------------------------------------------------- |
| answering a caller (RPC, REST, HTML fragments, GraphQL)   | `@btravstack/orpc-server`, `htmx-server`, `graphql-server` over HTTP    |
| tools for a language-model client (MCP)                   | `@btravstack/mcp-server` over HTTP, stateless; never stdio              |
| server-to-client push                                     | an oRPC procedure returning an `eventIterator` (SSE), never a WebSocket |
| a job, a retry, a delay, a schedule, a multi-step process | `@btravstack/temporal-worker` (Temporal Schedules are the cron)         |
| announcing a committed fact to whoever listens            | `@btravstack/amqp-worker`, fed by `@btravstack/outbox`                  |
| calling one of the above from another service             | `@btravstack/amqp-client`, `temporal-client`, `oauth-client`            |

There is no job-queue runtime, no scheduler runtime and no rate limiter (the
ingress limits). Do not build one inside the application.

## Add a capability

1. **Declare it in the contract package** — an oRPC procedure, an AMQP
   consumer, or a Temporal workflow and its activities. Name every refusal a
   caller must handle in `.errors({...})`.
2. **Write the use case as a port** whose methods return `AsyncResult` with a
   union of concrete `TaggedError`s, and a provider that builds it.
3. **Mint the transport piece from the contract key** —
   `api.OrpcController(contract, path)`, `AmqpHandler(contract, key)`,
   `TemporalWorkflowActivities(contract, key)` — and triage the use case's
   error union there with an exhaustive `mapErrCases`. That leaf is the one
   place a domain error becomes a transport error; never use `P._` in it.
   An MCP tool is the SDK's own `server.registerTool`, inside `mcp(auth, {
   server })`, answering through `toolResult` with `Err` triaged to
   `ToolRefused`.
4. **Ship the piece in a slice module** that provides and exports it, and
   imports the vertical it owns.
5. **Add the piece to the root's array** (`api.OrpcRouter(contract)([...])`,
   `AmqpHandlers(contract)([...])`, `TemporalActivities(contract)([...])`) and
   the slice to the root's `imports`.
6. **Run `tsc`** and read the marker (below). Then add a booted spec.

The HTTP walk-through, compiled, is [references/http.md](references/http.md).
For workers, follow
<https://btravstack.github.io/btravstack/how-to/split-a-worker-into-slices>; a
worker whose contract declares no workflows (an activity pool) omits
`workflows`. For MCP,
<https://btravstack.github.io/btravstack/how-to/serve-mcp>.

## Configuration

A setting is a provider bound from the kernel's `Env` port, validated once as
the graph is built. A bad value exits `78` with every offending variable named.

```ts
import { Config, Env } from "@btravstack/config";
import { Module, Port, Provider } from "@btravstack/di";

const billingConfig = Config.provider("BillingConfig")(
  Config.object({
    currency: Config.string("BILLING_CURRENCY", { default: "EUR" }),
  }),
);

export class Invoicer extends Port("Invoicer")<{
  readonly label: (cents: number) => string;
}> {}

export const BillingModule = Module("Billing")({
  needs: [Env],
  provides: [
    billingConfig,
    Provider(Invoicer)({
      inject: { config: billingConfig.port },
      sync: ({ config }) => ({
        label: (cents) => `${(cents / 100).toFixed(2)} ${config.currency}`,
      }),
    }),
  ],
  exports: [Invoicer],
});
```

- Never read `process.env`, and never call a schema's `.parse()` (it throws).
  Any Standard Schema validator may replace `Config.object`.
- An empty or blank variable is an error, not an absent one; `default` applies
  only to a variable nobody set.
- Prefix a variable with its component (`BILLING_`), except names the platform
  already owns (`PORT`, `DATABASE_URL`, `LOG_LEVEL`).
- Something belongs in the environment when it varies by deployment. A shape,
  an adapter choice or a security setting stays an option in code.

## Read the compile error

A wiring mistake fails `tsc` at the root, and the message ends with a marker
naming what is wrong. Read the whole message; the name is beside the marker.

| Marker                                              | Fix                                                        |
| --------------------------------------------------- | ---------------------------------------------------------- |
| `UNSATISFIED DEPENDENCIES — nothing provides`       | `provides`, or `imports` a module that provides it         |
| `UNSATISFIED RUNTIME PORTS`                         | `exports` on the root                                      |
| `NO RUNTIME`                                        | make the root a runtime module (`HttpModule`, …)           |
| `UNCOVERED CONTROLLERS` / `HANDLERS` / `ACTIVITIES` | add the missing piece to the array                         |
| `OVERLAPPING CONTROLLERS`                           | mint the two pieces at sibling paths                       |
| `UNDECLARED NEEDS`                                  | add the port to the slice's `needs`, or provide it         |
| `UNGRANTABLE SCOPE`                                 | the scheme's `scopes`, or the requirement on the procedure |

The full table: <https://btravstack.github.io/btravstack/how-to/read-a-wiring-error>.

## Rules that are easy to break

- **Hold `defineHttp()` whole.** `const api = defineHttp(...)`, one per
  application; destructuring it fails with `TS2527`.
- **Relative imports carry `.js`** under `moduleResolution: "nodenext"`.
- **A sequence is `flatTap` or `DoAsync`, never sibling `const`s.** An
  `AsyncResult` starts when it is built, so two `const`s run concurrently.
- **`OkAsync(v)` / `ErrAsync(e)`**, not `Ok(v).toAsync()`.
- **The tenant is a port the application declares**, provided by the
  deployment's unit module. Do not read it off the ambient unit, and do not
  take it as a procedure input.
- **`currentUnit()` is for infrastructure adapters** (a logger, an exporter).
  Services never go on the ambient record.
- **A transaction belongs to the adapter**, spelled at the call. There is no
  transaction per request; cross-store atomicity is the outbox.
- **A listing is paginated** with `@btravstack/contract`'s `keyset`, never an
  unbounded array.
- **Swapping an adapter is composing a different module.** Production roots
  never use `overridden`; tests do.

## Test

Boot the real root with `bootFixture`, call it through the contract's client,
substitute providers with `overridden`, and drive time with
`createFakeClock`. Compiled samples: [references/testing.md](references/testing.md).

## Verify before finishing

1. `tsc --noEmit` passes, with no marker left in its output.
2. The specs pass, including one that boots the root you changed.
3. Every `.errors({...})` entry you added is reached by a `mapErrCases` arm.
