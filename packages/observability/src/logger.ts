import {
  LEVELS,
  currentUnit,
  type Attributes,
  type Level,
  type LoggerService,
} from "@btravstack/core";

/** One line, as the implementation hands it to a {@link Sink}: the message, its severity, and everything known about it. */
export type Line = {
  readonly level: Level;
  readonly message: string;
  readonly attributes: Attributes;
  readonly cause: unknown;
  /** Milliseconds since the epoch, stamped when the line was written. */
  readonly time: number;
  /** What `currentUnit()` carried, or `undefined` outside a unit. */
  readonly unit:
    | { readonly unitId: string; readonly traceId: string; readonly tenantId?: string }
    | undefined;
};

/** Where a line goes. Given a {@link Line}, writes it — and never throws, which `createLogger` guarantees on its behalf. */
export type Sink = (line: Line) => void;

const severity = (level: Level): number => LEVELS.indexOf(level);

/**
 * A logger over `sink`, filtered at `level` and correlated with the ambient
 * unit.
 *
 * The correlation is read **per call**, not captured: one logger is built per
 * scope and every unit the kernel opens has its own record, so a logger that
 * captured it at construction would stamp the wrong trace id on every line but
 * the first. `with` layers attributes and nothing else, so a child costs one
 * object and shares the sink.
 *
 * Every path is wrapped: a sink that throws is swallowed here, because a
 * logger that takes the process down is worse than a line nobody sees.
 */
export const createLogger = (sink: Sink, level: Level = "info"): LoggerService => {
  const floor = severity(level);

  const build = (base: Attributes): LoggerService => {
    const write = (
      lineLevel: Level,
      message: string,
      attributes: Attributes | undefined,
      cause: unknown,
    ): void => {
      if (severity(lineLevel) < floor) return;
      const unit = currentUnit();
      try {
        sink({
          level: lineLevel,
          message,
          attributes: attributes === undefined ? base : { ...base, ...attributes },
          cause,
          time: Date.now(),
          unit:
            unit === undefined
              ? undefined
              : {
                  unitId: unit.unitId,
                  traceId: unit.traceId,
                  ...(unit.tenantId === undefined ? {} : { tenantId: unit.tenantId }),
                },
        });
      } catch {
        // deliberately swallowed: see the port's TSDoc — a broken sink must
        // not become an outage, and there is nowhere left to report it to.
      }
    };

    return {
      log: (lineLevel, message, attributes, cause) => write(lineLevel, message, attributes, cause),
      trace: (message, attributes, cause) => write("trace", message, attributes, cause),
      debug: (message, attributes, cause) => write("debug", message, attributes, cause),
      info: (message, attributes, cause) => write("info", message, attributes, cause),
      warn: (message, attributes, cause) => write("warn", message, attributes, cause),
      error: (message, attributes, cause) => write("error", message, attributes, cause),
      fatal: (message, attributes, cause) => write("fatal", message, attributes, cause),
      with: (attributes) => build({ ...base, ...attributes }),
      isEnabled: (lineLevel) => severity(lineLevel) >= floor,
    };
  };

  return build({});
};
