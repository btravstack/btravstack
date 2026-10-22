import { start } from "@btravstack/core";
import { Module, Provider, type ServiceOf } from "@btravstack/di";
import { HttpRequestMetadata } from "@btravstack/http-server";
import { oc } from "@orpc/contract";
import { OkAsync } from "unthrown";

import { defineHttp } from "./define-http.js";
import { HttpModule } from "./http-module.js";

class Locale extends Provider.class("MetadataLocale", {
  inject: { metadata: HttpRequestMetadata },
}) {
  public readonly value = this.deps.metadata.headers["x-locale"];
}
const RequestUnit = Module("MetadataUnit")({
  needs: [HttpRequestMetadata],
  provides: [Locale],
  exports: [Locale],
});
const api = defineHttp().units<{ anonymous: typeof RequestUnit }>();
const contract = { metadata: oc };
const controller = api.OrpcController(
  contract,
  "metadata",
)({
  unit: { locale: Locale },
  sync:
    () =>
    ({ context }) => {
      const request = context.request;
      const scope = context.host.ctx;
      const signal: AbortSignal = context.signal;
      return OkAsync({ request, scope, signal, locale: context.unit.locale.value });
    },
});
const root = HttpModule("MetadataRoot")({
  router: api.OrpcRouter(contract)([controller]),
  unit: { anonymous: RequestUnit },
});
void start(root);

declare const metadata: ServiceOf<HttpRequestMetadata>;
// @ts-expect-error request headers cannot be rewritten by an application provider
metadata.headers["x-locale"] = "other";
// @ts-expect-error request cancellation is the runtime's signal, never an application replacement
metadata.signal = new AbortController().signal;

const plain = defineHttp();
const misplaced = HttpModule("ApplicationMetadata")({
  router: plain.OrpcRouter({ ready: oc })({ sync: () => ({ ready: () => OkAsync("ready") }) }),
  provides: [Locale],
});
// @ts-expect-error request metadata is supplied only inside the request unit
void start(misplaced);
