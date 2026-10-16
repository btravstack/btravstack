---
title: Serve an MCP server
description: Serve tools to language-model clients over the Model Context Protocol with the official SDK, authenticated through the shared schemes.
---

# Serve an MCP server

> **How-to.** Expose an application's use cases as Model Context Protocol
> tools, behind the same authentication as its API.

Install `@btravstack/mcp-server` and `@modelcontextprotocol/sdk` beside the
HTTP runtime. Build the SDK's own `McpServer` in `server`; `mcp()` serves it
under `/mcp`:

```ts
import { defineAuth, protectedResource } from "@btravstack/http-server";
import { jwtAuthenticator } from "@btravstack/http-server/jwt";
import { McpModule, mcp } from "@btravstack/mcp-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OkAsync } from "unthrown";

type Caller = { readonly tenantId: string };

const auth = defineAuth({
  authenticators: {
    user: jwtAuthenticator<Caller>()({
      scopes: ["orders:read"],
      principal: (claims) =>
        typeof claims["tenant"] === "string" ? { tenantId: claims["tenant"] } : undefined,
    }),
  },
});

const answerer = mcp(auth, {
  requires: [{ user: ["orders:read"] }],
  server: ({ principal, toolResult }) => {
    const server = new McpServer({ name: "orders", version: "1.0.0" });
    server.registerTool(
      "current_tenant",
      { description: "The tenant this token acts for", inputSchema: {} },
      () => toolResult(OkAsync(principal.tenantId)),
    );
    return server;
  },
});

export const McpApi = McpModule("McpApi")({
  answerer,
  provides: [...protectedResource({ scopes: ["orders:read"] })],
});
```

- **`McpModule` is the deployment root**, as `GraphqlModule` is GraphQL's: it
  composes the listener, the answerer's authenticators and its declared
  request modules. To serve MCP beside an oRPC router instead, put the
  answerer and its `authenticators` in that `HttpModule`'s `provides` — when
  the answerer declares no `units` of its own: `HttpModule` binds the kinds
  its router and fragments declare, so an MCP answerer with units for another
  scheme belongs in its own `McpModule` deployment.
- **Each request gets its own server**, over a stateless transport answering
  JSON, so any replica answers any request and nothing outlives the call.
- **`server` is handed the call's context**: `principal`, what `requires`
  resolved; `unit`, the services of the request's unit, declared with
  `units` and `unit` exactly as for [GraphQL](/how-to/serve-graphql); the
  request's `signal`; and `toolResult`.
- **`toolResult` answers a tool from a `Result`.** `Ok` is text for a string,
  structured content beside its JSON text when that JSON is an object, and
  its JSON text alone for anything else — an array or a number included. `Err` is a
  `ToolRefused` your triage minted — an exhaustive `mapErrCases` over the use
  case's errors — and its `text` is the tool error the model reads. A defect, or a value JSON cannot encode, is reported to
  `Observers` and answered with a fixed
  text, so its cause never reaches the model.
- **A refused caller gets a bare `401` or `403`.**
  [`protectedResource()`](/reference/http-server#the-protected-resource) adds
  the challenge that tells an MCP client which authorization server to sign
  in with.
- **The body is bounded by `HTTP_BODY_LIMIT`**, as for every answerer.

Prompts and resources are the SDK's too: `server.registerPrompt` and
`server.registerResource` work unchanged. What the server would ask of the
client — sampling, elicitation, roots — is not available: the server is
stateless and answers JSON, so it neither keeps the capabilities the client
declared at `initialize` nor holds a stream to send a request on.
