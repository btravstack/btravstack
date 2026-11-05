// HTTP timeout options — packages/http-server/README.md and docs/reference/http-server.md.
import type { ServiceOf } from "@btravstack/di";

import { HttpConfig, type HttpOptions } from "./index.js";

const options: HttpOptions = {
  keepAliveTimeoutMs: 5_000,
  keepAliveTimeoutBufferMs: 1_000,
  socketTimeoutMs: 30_000,
};

declare const config: ServiceOf<HttpConfig>;
const keepAliveTimeoutMs: number = config.keepAliveTimeoutMs;
const keepAliveTimeoutBufferMs: number | undefined = config.keepAliveTimeoutBufferMs;
const socketTimeoutMs: number = config.socketTimeoutMs;
