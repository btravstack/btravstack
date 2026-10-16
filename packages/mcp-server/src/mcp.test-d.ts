import { Env } from "@btravstack/config";
import { Module, Port, Provider } from "@btravstack/di";
import { HttpAuthenticator, defineAuth } from "@btravstack/http-server";
import { HttpHandler, HttpRuntime, httpServer } from "@btravstack/http-server/internal";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expectTypeOf } from "vitest";

import { mcp } from "./mcp.js";

const user = HttpAuthenticator<{ id: string }, "tools:call">()({
  inject: {},
  sync: () => null as never,
});
const api = defineAuth({ authenticators: { user } });
const server = () => new McpServer({ name: "types", version: "1.0.0" });

class Message extends Port("McpMessage")<string> {}
class Missing extends Port("McpMissing")<string> {}
const userUnit = Module("McpUserUnit")({
  provides: [Provider(Message)({ inject: {}, value: "hello" })],
  exports: [Message],
});

// The context is typed by this call: the scheme's principal, the unit's ports.
mcp(api, {
  requires: [{ user: ["tools:call"] }],
  units: { user: userUnit },
  unit: { message: Message },
  server: ({ principal, unit }) => {
    expectTypeOf(principal).toEqualTypeOf<{ id: string }>();
    expectTypeOf(unit).toEqualTypeOf<{ readonly message: string }>();
    return server();
  },
});

// Without requirements nobody is resolved, and the principal says so.
mcp(api, {
  server: ({ principal }) => {
    expectTypeOf(principal).toEqualTypeOf<undefined>();
    return server();
  },
});

mcp(api, {
  requires: [{ user: [] }],
  units: { user: userUnit },
  // @ts-expect-error -- the selected user unit does not export this port
  unit: { missing: Missing },
  server,
});

// @ts-expect-error -- a scope outside the authenticator's vocabulary cannot protect a mount
mcp(api, { requires: [{ user: ["tools:write"] }], server });

const protectedAnswerer = mcp(api, { requires: [{ user: [] }], server });
// @ts-expect-error -- a protected MCP mount owes its scheme's provider
Module("MissingMcpAuthenticator")({
  needs: [Env],
  imports: [httpServer({ port: 0 })],
  provides: [protectedAnswerer],
  exports: [HttpRuntime, HttpHandler],
});

Module("ProtectedMcp")({
  needs: [Env],
  imports: [httpServer({ port: 0 })],
  provides: [protectedAnswerer, ...protectedAnswerer.authenticators],
  exports: [HttpRuntime, HttpHandler],
});
