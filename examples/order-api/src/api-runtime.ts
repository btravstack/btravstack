import type { Runtime } from "@btravstack/start-core";
import { FindOrder, Logger, PlaceOrder } from "@btravstack/start-example-order-application";
import { httpRuntime, type HttpInfo } from "@btravstack/start-http";

import { httpConfig } from "./config.js";
import { apiHandler } from "./handler.js";

/**
 * The ports this deployment's runtime resolves out of the application context:
 * the three the handler reaches, plus the config that says which port to bind.
 *
 * One array, two uses — the union below is read off it, so the declared needs
 * and the type the handler sees cannot drift apart.
 */
const apiRuntimeNeeds = [PlaceOrder, FindOrder, Logger, httpConfig] as const;

type ApiRuntimeNeeds = (typeof apiRuntimeNeeds)[number];

/**
 * `@btravstack/start-http`'s runtime, with this deployment's own answer to the
 * one question it asks that is configuration: which port.
 *
 * It takes **no arguments**. `main.ts` used to read `PORT` and hand the number
 * down; a runtime is given a `Context` at `start`, so it reads `httpConfig`
 * out of the graph itself and the entry point never learns what a port is.
 *
 * The package's runtime is therefore built **inside** `start`, once the
 * context exists — which is also why `name` and `needs` are stated here rather
 * than forwarded from it: those two have to be answerable before `start` runs.
 * `"http"` is `@btravstack/start-http`'s own name for itself.
 *
 * The specs deliberately do not use this: they call `httpRuntime({ port: 0 })`
 * directly, because an ephemeral bind read back off `Serving.info` is a
 * property of the test, not of the deployment. What they cover instead is the
 * transport; what covers this is `src/needs-gate.test-d.ts`.
 */
export const orderApiRuntime = (): Runtime<ApiRuntimeNeeds, HttpInfo> => ({
  name: "http",
  needs: apiRuntimeNeeds,
  start: (host) =>
    httpRuntime({
      port: host.ctx.get(httpConfig).port,
      needs: apiRuntimeNeeds,
      handler: apiHandler,
    }).start(host),
});
