# @btravstack/mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io) answerer for the
protocol-neutral [`@btravstack/http-server`](../http-server) runtime, over the
official [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk).
The SDK owns the protocol; `mcp()` owns what the runtime owns for every
answerer: authentication through the shared schemes, the request's unit and
the body limit.

```sh
pnpm add @btravstack/mcp-server @btravstack/http-server @btravstack/core \
  @btravstack/config @btravstack/di @btravstack/contract \
  @modelcontextprotocol/sdk zod unthrown
```

```ts
import { defineAuth } from "@btravstack/http-server";
import { mcp } from "@btravstack/mcp-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OkAsync } from "unthrown";

export const answerer = mcp(defineAuth(), {
  server: ({ toolResult }) => {
    const server = new McpServer({ name: "hello", version: "1.0.0" });
    server.registerTool("hello", { inputSchema: {} }, () => toolResult(OkAsync("world")));
    return server;
  },
});
```

`server` builds the SDK's own `McpServer` for one request: the transport is
stateless and answers JSON, so any replica answers any request. It is handed
the `principal` that `requires` resolved, the `unit` record read off the
forked kind, the request's `signal`, and `toolResult`, which answers a tool
from a `Result` — `Ok` as text, or structured content for a plain object, `Err` — a `ToolRefused` — as a tool
error whose `text` the model reads, a defect as a generic tool error reported to `Observers`.

`McpModule("Name")({ answerer })` is the deployment root, as `GraphqlModule`
is GraphQL's.

A caller no requirement accepts gets a bare `401`, an under-scoped one a
`403`. Compose `protectedResource()` from `@btravstack/http-server` and the
`401` tells an MCP client where to sign in.

See [Serve MCP](https://btravstack.github.io/btravstack/how-to/serve-mcp).
