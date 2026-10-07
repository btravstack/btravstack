---
title: Add a slice by copying a sibling
description: Add a controller, a consumer or a workflow's activities to a deployment by copying a sibling slice — the contract key in its contract package, the slice directory, and the root's array — and let pnpm typecheck name whatever you missed.
---

# Add a slice by copying a sibling

> **How-to.** Grow a deployment by one slice — an HTTP controller, an AMQP
> consumer or a Temporal workflow's activities — without a generator. For what
> a slice is and why it is shaped this way, see
> [Split a router into controllers](/how-to/split-a-router-into-controllers)
> and [Split a worker into slices](/how-to/split-a-worker-into-slices).

There is no `generate slice` command, and none is needed: a slice is the same
shape on all three transports — a transport file minting one piece from
`(contract, key)`, and a `module.ts` providing and exporting it — so the
sibling directory **is** the template. What no template can collapse is that
the contract lives in a different package from its implementation, so adding
a slice touches three places, in this order.

## 1. Declare the key in the contract package

The contract is the source of truth, and a client takes it without the
server, so the new key goes there first:

| Transport | Contract package                   | What you add                                |
| --------- | ---------------------------------- | ------------------------------------------- |
| HTTP      | `examples/order-api-contract`      | a fragment under a new key of `contract`    |
| AMQP      | `examples/order-amqp-contract`     | a consumer (and its queue binding)          |
| Temporal  | `examples/order-temporal-contract` | a workflow and its activities' declarations |

Nothing else compiles against a key the contract does not have, which is why
this step comes first.

## 2. Copy the sibling directory

```sh
cp -r examples/order-amqp-worker/src/slices/audit examples/order-amqp-worker/src/slices/invoicing
```

Then rename, in the two files you copied:

- **the key** passed to the mint call — `AmqpHandler(orderContract, "orderAudit")`
  becomes the key you declared in step 1;
- **the export names** — `orderAudit` → `orderInvoicing`,
  `AuditSlice` → `InvoicingSlice`, and the `Module("…")` name with it;
- **the body** — the leaf itself, and the module's `needs` and `imports`,
  which say what **this** slice's providers take from outside and which
  vertical it owns.

The file to copy is named for its transport, and so is the call inside it:

| Transport | Sibling to copy                                      | The mint call                                                  |
| --------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| HTTP      | `examples/order-api/src/slices/customers/`           | `api.OrpcController(contract, path)` in `controller.ts`        |
| AMQP      | `examples/order-amqp-worker/src/slices/audit/`       | `AmqpHandler(contract, key)` in `handler.ts`                   |
| Temporal  | `examples/order-temporal-worker/src/slices/billing/` | `TemporalWorkflowActivities(contract, key)` in `activities.ts` |

A Temporal workflow's **body** is the one part that does not live in the
slice: it runs in Temporal's workflow sandbox, bundled from the deployment's
`workflows.ts`, so the workflow itself — its `declareWorkflow` export — is added
there and only its activities are the slice's. **It is also the one step the
compiler does not check** (step 4 says what does).

## 3. Add it to the root

In the deployment's `src/module.ts`, put the piece in the composing array and
the slice module in `imports`:

| Transport | The array                                               | And in `imports` |
| --------- | ------------------------------------------------------- | ---------------- |
| HTTP      | `api.OrpcRouter(contract)([…, newController])`          | the slice module |
| AMQP      | `AmqpHandlers(orderContract)([…, newHandler])`          | the slice module |
| Temporal  | `TemporalActivities(orderContract)([…, newActivities])` | the slice module |

## 4. Let the compiler name what you missed

Run `pnpm typecheck`. Every step above but one has its own error, at the
place that step lives, so a forgotten one is named rather than discovered at
boot:

| Forgot                         | What `pnpm typecheck` reports                                         |
| ------------------------------ | --------------------------------------------------------------------- |
| step 1, the contract key       | the mint call refuses a key the contract does not declare             |
| step 3, the piece in the array | `UNCOVERED HANDLERS` (or `CONTROLLERS`, `ACTIVITIES`), naming the key |
| step 3, the slice in `imports` | the root has an `UNDECLARED NEEDS` naming the piece's port            |
| the new slice's own `needs`    | the slice module has an `UNDECLARED NEEDS` naming the port it reads   |

[Read a wiring error](/how-to/read-a-wiring-error) says where in each message
the name is.

**The exception is a Temporal workflow's `declareWorkflow` export.**
`TemporalActivities` checks that every activity is covered, but the worker
takes `workflows.ts` as a bundle **path**, which no type reaches. Forget the
export and `pnpm typecheck` stays green, the worker boots with the workflows it
already had, and the new one fails only when it is invoked: its workflow task
fails for a type the bundle never registered, and Temporal retries the task, so
the execution never completes. What catches it is a spec that runs the new
workflow end to end through the real worker — `client.executeWorkflow("…", …)`,
as `examples/order-temporal-worker/src/temporal-runtime.spec.ts` does for
`fulfillOrder` — which then times out instead of passing.

Then copy the sibling's spec the same way: a deployment's specs
drive it through the real root on its `test-fixtures.ts`, so a new case is a
new `it` on fixtures that already exist.

## Where to go next

- What belongs inside a slice, and what stays at the root:
  [Split a worker into slices](/how-to/split-a-worker-into-slices#what-a-slice-owns).
- Lifting one slice into a deployment of its own:
  [Split a router into controllers](/how-to/split-a-router-into-controllers).
- The worked deployments: [Order API (HTTP)](/examples/order-api),
  [Order AMQP worker](/examples/order-amqp-worker),
  [Order Temporal worker](/examples/order-temporal-worker).
