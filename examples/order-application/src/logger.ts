import { currentUnit } from "@btravstack/core";
import { Provider } from "@btravstack/di";

import { Logger } from "./ports.js";

/**
 * The single kernel touchpoint in this layer. `currentUnit()` is read fresh on
 * every call rather than captured at construction: one `Logger` is built per
 * scope, but each unit the kernel opens has its own trace id, so reading it
 * later is what makes the lines attributable. Outside a unit — this package's
 * own specs, for instance — there is none, and the line reads `[-]`.
 */
export const loggerProvider = Provider(Logger)({
  sync: () => {
    const lines: string[] = [];
    return {
      info: (message: string) => {
        lines.push(`[${currentUnit()?.traceId ?? "-"}] ${message}`);
      },
      lines: () => lines,
    };
  },
});
