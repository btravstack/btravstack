---
title: Stream with server-sent events
description: Declare an event-iterator procedure, serve it to an oRPC client and to a browser's EventSource, resume from Last-Event-ID, and know what a deploy does to an open stream.
---

<!-- doctest: prelude
import { api } from "../../auth.js";
-->

# Stream with server-sent events

> **How-to.** Answer one request with many events over one connection. For
> the package's full surface, see
> [`@btravstack/http-server`](/reference/http-server); for what the drain
> does to a stream and why, see
> [Draining, in three beats](/explanation/draining-in-three-beats).

A procedure whose output is an `eventIterator` is served as
`text/event-stream`. Nothing in the starter has to be configured for it:
oRPC encodes the events, flushes the headers with an initial comment, and
sends a keep-alive comment every 15 s so an ingress or load balancer does
not idle the connection out. Compression skips it.

## Recipe

### 1. Declare the procedure

```ts
import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";

export const contract = oc.router({
  orderEvents: oc
    .input(z.object({ orderId: z.string() }))
    .output(eventIterator(z.object({ status: z.string() }))),
});
```

### 2. Implement it as a generator

The handler returns `Ok` of an async iterator. oRPC's `signal` aborts when
the client leaves **or when the runtime resets the stream at a drain**, so
the loop condition is also the cleanup hook.

```ts
import { withEventMeta } from "@orpc/client";
import { OkAsync } from "unthrown";

const statuses = ["placed", "reserved", "shipped"];

export const router = api.OrpcRouter(contract)({
  inject: {},
  sync: () => ({
    orderEvents: ({ input, signal, lastEventId }) => {
      const from = lastEventId === undefined ? 0 : Number(lastEventId) + 1;
      async function* events() {
        for (let i = from; i < statuses.length && !signal?.aborted; i += 1) {
          const status = `${input.orderId}:${statuses[i] ?? "unknown"}`;
          yield withEventMeta({ status }, { id: String(i), retry: 2_000 });
        }
      }
      return OkAsync(events());
    },
  }),
});
```

`withEventMeta` stamps an `id` on each event and a `retry` delay on the
client. Reading oRPC's `lastEventId` handler option is what makes a reconnect
resume rather than restart — that part is the application's, not the
starter's.

### 3. Consume it from an oRPC client

An oRPC client does not reconnect by itself. `RetryLinkPlugin` does, sending
`Last-Event-ID`, once a call asks for it:

```ts
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { RetryLinkPlugin } from "@orpc/client/plugins";
import type { RouterContractClient } from "@orpc/contract";

const client: RouterContractClient<typeof contract> = createORPCClient(
  new RPCLink({
    origin: "http://localhost:3000",
    url: "/rpc",
    plugins: [new RetryLinkPlugin()],
  }),
);

export const follow = async (orderId: string) => {
  const events = await client.orderEvents({ orderId }, { context: { retry: 3 } });
  for await (const event of events) console.log(event.status);
};
```

### 4. Or from a browser

`EventSource` can only send `GET`, so the starter admits `GET` on a
procedure whose output is an event iterator — and on nothing else. The
browser reconnects on its own, after the `retry` delay, with
`Last-Event-ID`.

<!-- doctest: skip — browser code, `EventSource` is not in the node typings this gate compiles under -->

```ts
const data = encodeURIComponent(JSON.stringify({ json: { orderId: "42" } }));
const source = new EventSource(`/rpc/orderEvents?data=${data}`);
source.onmessage = (event) => console.log(JSON.parse(event.data).json);
```

The RPC protocol carries a `GET` input as the `data` query parameter, holding
oRPC's own serialized envelope `{"json": <input>}` rather than the input
itself — `RPCJsonSerializer` reads its `json` key back out on decode. Each
event's `data` is the same envelope, so a reader parses it and reaches for
`.json` too.

## What a deploy does to an open stream

A stream is a unit: it opened with the request and closes with the
response. When a drain begins, the runtime **resets** every open
`text/event-stream` response at beat 3's start — after readiness went false
and the pre-drain delay gave the ingress time to stop routing here — and
the client's reconnect lands on a replica that is staying. Once its headers
have flushed, the unit is counted `completed` rather than `abandoned`, and
the generator's `finally` runs; a stream still waiting on its first event
when the drain begins is only marked to close, and is abandoned like any
other unit still open past `drainTimeoutMs`.

It is a reset rather than a clean end on purpose: an oRPC client reads a
clean end as the iterator finishing and does not reconnect. So a client
that cannot survive a reconnect is broken before this framework enters the
picture — the first ingress idle timeout or node upgrade would have cut it
too — and the framework's promise is to never end a stream for no reason,
and to end it at the one moment a reconnect is free when the process must go.
