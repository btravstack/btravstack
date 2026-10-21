import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { defineHttp } from "./define-http.js";
import { HttpModule } from "./http-module.js";
import { openApiDocumentRoute, type OpenApiDocument } from "./openapi.js";

describe("openApiDocumentRoute", () => {
  it.for([
    ["GET", "/v1/openapi.json?download=1", 200, JSON.stringify(document), null],
    ["HEAD", "/v1/openapi.json", 200, "", null],
    ["POST", "/v1/openapi.json", 405, "", "GET, HEAD"],
    ["GET", "/v1/openapi.json/child", 404, "", null],
    ["GET", "/v1/openapi.json/", 404, "", null],
  ] as const)(
    "serves %s %s with status %s",
    async ([method, path, status, body, allow], { boot }) => {
      // GIVEN a public document mounted beside the router
      const app = HttpModule("DocumentRoute")({
        router: defineHttp().OrpcRouter({})({ sync: () => ({}) }),
        port: 0,
        hostname: "127.0.0.1",
        provides: [openApiDocumentRoute({ path: "/v1/openapi.json", document })],
      });
      const info = (await boot(app).runtimeInfo()).get();

      // WHEN the document path is requested
      const response = await fetch(`http://127.0.0.1:${info?.port}${path}`, { method });

      // THEN only GET and HEAD at the mount serve the document
      expect({
        status: response.status,
        body: await response.text(),
        allow: response.headers.get("allow"),
      }).toEqual({ status, body, allow });
    },
  );
});

const document: OpenApiDocument = {
  openapi: "3.1.0",
  info: { title: "Example", version: "1" },
  paths: {},
};
