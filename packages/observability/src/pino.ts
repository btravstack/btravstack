import type { Logger as PinoLogger } from "pino";

import type { Line, Sink } from "./logger.js";

/**
 * A {@link Sink} over a pino logger — the subpath a deployment reaches for
 * when the default JSON sink's `JSON.stringify` per line is the thing showing
 * up in a profile. `pino` is an **optional** peer: install it, import
 * `@btravstack/observability/pino`, and pass the sink; a consumer that never
 * imports this file never needs it.
 *
 * ```ts
 * import pino from "pino";
 * import { observability } from "@btravstack/observability";
 * import { pinoSink } from "@btravstack/observability/pino";
 *
 * observability({ sink: pinoSink(pino()) });
 * ```
 *
 * The level filter stays **ours**: `createLogger` has already decided the
 * line is worth writing by the time a sink sees it, so pino is configured at
 * `trace` here — one filter in the process, and it is the one `LOG_LEVEL`
 * validated at startup. `fatal` and `trace` map to pino's own; the ambient
 * unit's ids ride as fields, not as a message prefix, so they stay indexable.
 */
export const pinoSink =
  (logger: PinoLogger): Sink =>
  (line: Line) => {
    const { level, message, attributes, cause, unit } = line;
    const fields = {
      ...attributes,
      ...(unit === undefined ? {} : unit),
      // pino renders `err` through its own error serialiser, which keeps the
      // non-enumerable `message` and `stack` a bare `JSON.stringify` drops.
      ...(cause === undefined ? {} : { err: cause }),
    };
    // A sink never throws: `createLogger` swallows what escapes here, and a
    // pino transport that has closed under a shutdown is the case that would.
    logger[level](fields, message);
  };
