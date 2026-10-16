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
        bearer_methods_supported: ["header"],
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
    const answered = await get("/mcp/explicit");

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

  it("does not challenge an answer that is not a refusal", async ({ protectedResource }) => {
    // GIVEN the resource at /mcp
    const get = await protectedResource(MCP);

    // WHEN a path under it is served
    const answered = await get("/mcp/ok");

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
    const answered = await get("/mcp/");

    // THEN only the slash after the host was dropped (RFC 9728 §3.1)
    expect(answered.challenge).toBe(
      'Bearer resource_metadata="https://api.test/.well-known/oauth-protected-resource/mcp/?tenant=a"',
    );
  });

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
      bearer_methods_supported: ["header"],
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

  it("refuses a resource identifier carrying a fragment at boot", async ({ protectedApp }) => {
    // GIVEN a resource identifier no request can carry whole
    const app = protectedApp({ ...MCP, resource: "https://api.test/mcp#section" });

    // WHEN the application boots
    // THEN it does not, and the variable is named
    await expect(app.exited).toBeErrWith(
      expect.objectContaining({
        issues: [expect.objectContaining({ path: ["HTTP_RESOURCE_URI"] })],
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
          { message: "must list absolute URLs", path: ["HTTP_RESOURCE_AUTHORIZATION_SERVERS"] },
        ],
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

  it("challenges nobody when no protected resource is composed", async ({ serve }) => {
    // GIVEN the transport with no protected resource in its graph
    const { origin } = await serve();

    // WHEN a request is answered
    const response = await fetch(origin);

    // THEN no challenge is sent
    expect(response.headers.get("www-authenticate")).toBeNull();
  });
});
