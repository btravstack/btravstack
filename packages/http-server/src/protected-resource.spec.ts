import { it } from "@btravstack/internal-http-fixtures";
import { describe, expect } from "vitest";

const MCP = {
  resource: "https://api.test/mcp",
  authorizationServers: ["https://login.test/"],
} as const;

describe("protectedResource", () => {
  it("serves its metadata under the well-known path, suffixed with the resource's own", async ({
    protectedResource,
  }) => {
    // GIVEN a resource at /mcp advertising one scope
    const get = await protectedResource({ ...MCP, scopes: ["orders:read"] });

    // WHEN a client fetches the metadata RFC 9728 places for it
    const answered = await get("/.well-known/oauth-protected-resource/mcp");

    // THEN the document names the resource, its issuer and how a token is sent
    expect({ status: answered.status, document: JSON.parse(answered.body) }).toEqual({
      status: 200,
      document: {
        resource: "https://api.test/mcp",
        authorization_servers: ["https://login.test/"],
        scopes_supported: ["orders:read"],
      },
    });
  });

  it("challenges a refused caller with where that metadata is", async ({ protectedResource }) => {
    // GIVEN the same resource, beside an answerer that refuses every caller
    const get = await protectedResource(MCP);

    // WHEN a caller with no token reaches it
    const answered = await get("/mcp");

    // THEN the 401 tells it where to start
    expect({ status: answered.status, challenge: answered.challenge }).toEqual({
      status: 401,
      challenge:
        'Bearer resource_metadata="https://api.test/.well-known/oauth-protected-resource/mcp"',
    });
  });

  it("challenges a refusal written through writeHead too", async ({ protectedResource }) => {
    // GIVEN the resource at /mcp
    const get = await protectedResource(MCP);

    // WHEN its answerer refuses with an explicit `writeHead(401, headers)`
    const answered = await get("/mcp", "explicit");

    // THEN the challenge rides that answer as well
    expect(answered.challenge).toBe(
      'Bearer resource_metadata="https://api.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("does not challenge a refusal outside the resource", async ({ protectedResource }) => {
    // GIVEN the resource at /mcp
    const get = await protectedResource(MCP);

    // WHEN a path that is another resource is refused
    const answered = await get("/rpc/orders");

    // THEN no challenge points it at metadata describing /mcp (RFC 9728 §3.3)
    expect({ status: answered.status, challenge: answered.challenge }).toEqual({
      status: 401,
      challenge: null,
    });
  });

  it("does not challenge a refusal below the resource", async ({ protectedResource }) => {
    // GIVEN the resource at /mcp
    const get = await protectedResource(MCP);

    // WHEN a path below it is refused
    const answered = await get("/mcp/orders");

    // THEN no challenge: a client would discard metadata naming /mcp (RFC 9728 §3.3)
    expect({ status: answered.status, challenge: answered.challenge }).toEqual({
      status: 401,
      challenge: null,
    });
  });

  it("does not challenge a refusal for another host", async ({ protectedResource }) => {
    // GIVEN the resource at https://api.test/mcp
    const get = await protectedResource(MCP);

    // WHEN the same path is refused through another host name
    const answered = await get("/mcp", undefined, "alias.test");

    // THEN that is another resource's URL, and it is not pointed at this one's metadata
    expect(answered.challenge).toBeNull();
  });

  it("reads the authority of an absolute-form target over its Host", async ({
    protectedResource,
  }) => {
    // GIVEN the resource at https://api.test/mcp
    const get = await protectedResource(MCP);

    // WHEN a forward proxy names another authority in the target itself
    const answered = await get("http://alias.test/mcp");

    // THEN that authority is the one requested, and it is another resource's
    expect(answered.challenge).toBeNull();
  });

  it("does not challenge an absolute-form target under another scheme", async ({
    protectedResource,
  }) => {
    // GIVEN the resource at https://api.test/mcp
    const get = await protectedResource(MCP);

    // WHEN a forward proxy asks for the same host and path over http
    const answered = await get("http://api.test/mcp");

    // THEN that is another URL, so another resource
    expect(answered.challenge).toBeNull();
  });

  it("challenges a Host naming the scheme's default port", async ({ protectedResource }) => {
    // GIVEN the resource at https://api.test/mcp
    const get = await protectedResource(MCP);

    // WHEN a proxy forwards the external port explicitly
    const answered = await get("/mcp", undefined, "api.test:443");

    // THEN it is the same authority, so the same resource
    expect(answered.challenge).toBe(
      'Bearer resource_metadata="https://api.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("serves the metadata of a query-selected resource under that query alone", async ({
    protectedResource,
  }) => {
    // GIVEN a resource identified by its query
    const get = await protectedResource({ ...MCP, resource: "https://api.test/mcp?tenant=a" });

    // WHEN the metadata URL of another query is fetched
    const answered = await get("/.well-known/oauth-protected-resource/mcp?tenant=b");

    // THEN there is nothing there: this document describes tenant a
    expect(answered.status).toBe(404);
  });

  it("does not challenge an origin-form path that merely looks like an authority", async ({
    protectedResource,
  }) => {
    // GIVEN the resource at https://api.test/mcp
    const get = await protectedResource(MCP);

    // WHEN the path sent is `//alias.test/mcp`, which a base would read as a host
    const answered = await get("//alias.test/mcp");

    // THEN it is compared as sent, and is not /mcp
    expect(answered.challenge).toBeNull();
  });

  it("serves the metadata of a resource with a trailing slash at that path alone", async ({
    protectedResource,
  }) => {
    // GIVEN a resource identified with a trailing slash
    const get = await protectedResource({ ...MCP, resource: "https://api.test/mcp/" });

    // WHEN the metadata URL of the slashless resource is fetched
    const answered = await get("/.well-known/oauth-protected-resource/mcp");

    // THEN there is nothing there: this document describes /mcp/
    expect(answered.status).toBe(404);
  });

  it("does not challenge a refusal for the same path without its slash", async ({
    protectedResource,
  }) => {
    // GIVEN a resource identified with a trailing slash
    const get = await protectedResource({ ...MCP, resource: "https://api.test/mcp/" });

    // WHEN the path without it is refused
    const answered = await get("/mcp");

    // THEN that is another URL, so another resource
    expect(answered.challenge).toBeNull();
  });

  it("publishes the resource identifier as serialized", async ({ protectedResource }) => {
    // GIVEN a resource whose query is not ASCII
    const get = await protectedResource({ ...MCP, resource: "https://api.test/mcp?tenant=東京" });

    // WHEN a client fetches its metadata
    const answered = await get(
      "/.well-known/oauth-protected-resource/mcp?tenant=%E6%9D%B1%E4%BA%AC",
    );

    // THEN the document names it as the client requests it
    expect(JSON.parse(answered.body)).toEqual(
      expect.objectContaining({ resource: "https://api.test/mcp?tenant=%E6%9D%B1%E4%BA%AC" }),
    );
  });

  it("does not challenge a refusal under another query", async ({ protectedResource }) => {
    // GIVEN a resource identified by its query
    const get = await protectedResource({ ...MCP, resource: "https://api.test/mcp?tenant=a" });

    // WHEN the same path is refused under another one
    const answered = await get("/mcp?tenant=b");

    // THEN that is another resource, and it is not pointed at this one's metadata
    expect(answered.challenge).toBeNull();
  });

  it("percent-encodes the query it puts in the challenge", async ({ protectedResource }) => {
    // GIVEN a resource whose query is not ASCII
    const get = await protectedResource({ ...MCP, resource: "https://api.test/mcp?tenant=東京" });

    // WHEN a caller with no token reaches it, as a client sends it
    const answered = await get("/mcp?tenant=%E6%9D%B1%E4%BA%AC");

    // THEN the header carries the URL serialized, as a header must
    expect(answered.challenge).toBe(
      'Bearer resource_metadata="https://api.test/.well-known/oauth-protected-resource/mcp?tenant=%E6%9D%B1%E4%BA%AC"',
    );
  });

  it("does not challenge an answer that is not a refusal", async ({ protectedResource }) => {
    // GIVEN the resource at /mcp
    const get = await protectedResource(MCP);

    // WHEN its own URL is served
    const answered = await get("/mcp", "ok");

    // THEN it carries no challenge, which a client would read as metadata to refetch
    expect({ status: answered.status, challenge: answered.challenge }).toEqual({
      status: 200,
      challenge: null,
    });
  });

  it("keeps the resource's query and trailing slash in the metadata URL", async ({
    protectedResource,
  }) => {
    // GIVEN a resource identified with a trailing slash and a query
    const get = await protectedResource({ ...MCP, resource: "https://api.test/mcp/?tenant=a" });

    // WHEN a caller with no token reaches it
    const answered = await get("/mcp/?tenant=a");

    // THEN only the slash after the host was dropped (RFC 9728 §3.1)
    expect(answered.challenge).toBe(
      'Bearer resource_metadata="https://api.test/.well-known/oauth-protected-resource/mcp/?tenant=a"',
    );
  });

  it("refuses a resource identifier ending in an empty query at boot", async ({ protectedApp }) => {
    // GIVEN an identifier ending in a bare `?`, which some clients drop
    const app = protectedApp({ ...MCP, resource: "https://api.test/mcp?" });

    // WHEN the application boots
    // THEN it does not: no request could be matched to it reliably
    await expect(app.exited).toBeErrWith(
      expect.objectContaining({
        issues: [{ message: "must not end in an empty query", path: ["HTTP_RESOURCE_URI"] }],
      }),
    );
  });

  it("reads a request's bare ? as no query", async ({ protectedResource }) => {
    // GIVEN the resource at https://api.test/mcp
    const get = await protectedResource(MCP);

    // WHEN a client sends the URL with an empty query
    const answered = await get("/mcp?");

    // THEN it is the same request target, and challenged
    expect(answered.challenge).toBe(
      'Bearer resource_metadata="https://api.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it.for(["https://api.test/mcp#section", "https://api.test/mcp#"])(
    "refuses the resource identifier %s, which carries a fragment",
    async (resource, { protectedApp }) => {
      // GIVEN a resource identifier with a fragment, empty or not
      const app = protectedApp({ ...MCP, resource });

      // WHEN the application boots
      // THEN it does not, and the variable is named
      await expect(app.exited).toBeErrWith(
        expect.objectContaining({
          issues: [expect.objectContaining({ path: ["HTTP_RESOURCE_URI"] })],
        }),
      );
    },
  );

  it("omits scopes_supported when the list is empty", async ({ protectedResource }) => {
    // GIVEN a resource advertising an empty list of scopes
    const get = await protectedResource({ ...MCP, scopes: [] });

    // WHEN a client fetches the metadata
    const answered = await get("/.well-known/oauth-protected-resource/mcp");

    // THEN the parameter is absent rather than empty (RFC 9728 §3.2)
    expect(JSON.parse(answered.body)).not.toHaveProperty("scopes_supported");
  });

  it("describes a resource with no path at the bare well-known URI", async ({
    protectedResource,
  }) => {
    // GIVEN a resource identified by its origin alone, with no scopes to advertise
    const get = await protectedResource({ ...MCP, resource: "https://api.test/" });

    // WHEN a client fetches the metadata
    const answered = await get("/.well-known/oauth-protected-resource");

    // THEN it is served there, and claims no scope it was not given
    expect(JSON.parse(answered.body)).toEqual({
      resource: "https://api.test/",
      authorization_servers: ["https://login.test/"],
    });
  });

  it("answers 404 for anything but a GET of the document", async ({ protectedResource }) => {
    // GIVEN the resource at /mcp
    const get = await protectedResource(MCP);

    // WHEN a path below the document's own is requested
    const answered = await get("/.well-known/oauth-protected-resource/mcp/more");

    // THEN its mount answers, and has nothing there
    expect(answered.status).toBe(404);
  });

  it("reads the resource and its issuers from the environment", async ({ protectedApp }) => {
    // GIVEN no pins, and a deployment setting both variables
    const app = protectedApp(
      {},
      {
        HTTP_RESOURCE_URI: "https://api.test/mcp",
        HTTP_RESOURCE_AUTHORIZATION_SERVERS: "https://login.test/, https://partners.test/",
      },
    );

    // WHEN the metadata is fetched
    const info = (await app.runtimeInfo()).get();
    const response = await fetch(
      `http://127.0.0.1:${info?.port}/.well-known/oauth-protected-resource/mcp`,
    );

    // THEN it describes what the environment said
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        resource: "https://api.test/mcp",
        authorization_servers: ["https://login.test/", "https://partners.test/"],
      }),
    );
  });

  it("refuses a cleartext resource at boot", async ({ protectedApp }) => {
    // GIVEN a resource identifier a client would send its token to in the open
    const app = protectedApp({ ...MCP, resource: "http://api.test/mcp" });

    // WHEN the application boots
    // THEN it does not, and the variable is named
    await expect(app.exited).toBeErrWith(
      expect.objectContaining({
        port: "HttpProtectedResource",
        issues: [
          expect.objectContaining({
            message: expect.stringContaining("https:"),
            path: ["HTTP_RESOURCE_URI"],
          }),
        ],
      }),
    );
  });

  it("refuses a cleartext authorization server at boot", async ({ protectedApp }) => {
    // GIVEN an issuer a client would sign in with in the open
    const app = protectedApp({ ...MCP, authorizationServers: ["http://login.test/"] });

    // WHEN the application boots
    // THEN it does not, and the variable is named
    await expect(app.exited).toBeErrWith(
      expect.objectContaining({
        issues: [expect.objectContaining({ path: ["HTTP_RESOURCE_AUTHORIZATION_SERVERS"] })],
      }),
    );
  });

  it("refuses an authorization server that is not a URL at boot", async ({ protectedApp }) => {
    // GIVEN an entry `Config.list` accepts and no client could follow
    const app = protectedApp({ ...MCP, authorizationServers: ["login.test"] });

    // WHEN the application boots
    // THEN it is a configuration error naming the variable, not a defect
    await expect(app.exited).toBeErrWith(
      expect.objectContaining({
        port: "HttpProtectedResource",
        issues: [
          {
            message:
              "must list issuer identifiers: absolute URLs as the parser spells them, with no credentials, query or fragment",
            path: ["HTTP_RESOURCE_AUTHORIZATION_SERVERS"],
          },
        ],
      }),
    );
  });

  it.for([
    "https://login.test/?tenant=a",
    "https://login.test/?",
    "https://login.test/#",
    " https://login.test",
    "https:login.test",
    "https://user:secret@login.test",
  ])("refuses the authorization server %s at boot", async (server, { protectedApp }) => {
    // GIVEN an issuer a client could not derive the server's metadata URL from
    const app = protectedApp({ ...MCP, authorizationServers: [server] });

    // WHEN the application boots
    // THEN it is refused, as RFC 8414 §2 refuses such an issuer identifier
    await expect(app.exited).toBeErrWith(
      expect.objectContaining({
        issues: [expect.objectContaining({ path: ["HTTP_RESOURCE_AUTHORIZATION_SERVERS"] })],
      }),
    );
  });

  it("names every offending variable in one boot", async ({ protectedApp }) => {
    // GIVEN a resource with a fragment and an authorization server that is not a URL
    const app = protectedApp({
      resource: "https://api.test/mcp#section",
      authorizationServers: ["login.test"],
    });

    // WHEN the application boots
    // THEN both are reported together, so one fix-and-restart is enough
    await expect(app.exited).toBeErrWith(
      expect.objectContaining({
        issues: [
          expect.objectContaining({ path: ["HTTP_RESOURCE_URI"] }),
          expect.objectContaining({ path: ["HTTP_RESOURCE_AUTHORIZATION_SERVERS"] }),
        ],
      }),
    );
  });

  it("refuses a resource identifier carrying credentials at boot", async ({ protectedApp }) => {
    // GIVEN credentials in the identifier a public document would publish
    const app = protectedApp({ ...MCP, resource: "https://user:secret@api.test/mcp" });

    // WHEN the application boots
    // THEN it does not, and the variable is named
    await expect(app.exited).toBeErrWith(
      expect.objectContaining({
        issues: [{ message: "must not carry credentials", path: ["HTTP_RESOURCE_URI"] }],
      }),
    );
  });

  it("takes a cleartext resource once the deployment opted in at the call", async ({
    protectedResource,
  }) => {
    // GIVEN the same resource with `allowInsecure` pinned
    const get = await protectedResource({
      ...MCP,
      resource: "http://api.test/mcp",
      allowInsecure: true,
    });

    // WHEN a caller with no token reaches it
    const answered = await get("/mcp");

    // THEN it boots and challenges as configured
    expect(answered.challenge).toBe(
      'Bearer resource_metadata="http://api.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("challenges through the low-level http() module too", async ({ protectedRpc }) => {
    // GIVEN `http()` imported, and the protected resource composed beside it
    const get = await protectedRpc();

    // WHEN the resource refuses a caller
    const answered = await get("/mcp");

    // THEN the runtime inside `http()` saw the challenge it re-exports
    expect(answered.challenge).toBe(
      'Bearer resource_metadata="https://api.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("challenges nobody when no protected resource is composed", async ({ serve }) => {
    // GIVEN the transport with no protected resource in its graph
    const { origin } = await serve();

    // WHEN a request is answered
    const response = await fetch(origin);

    // THEN no challenge is sent
    expect(response.headers.get("www-authenticate")).toBeNull();
  });
});
