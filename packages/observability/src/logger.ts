import { currentUnit } from "@btravstack/core";
import { Port } from "@btravstack/di";

/**
 * The severity of one line, and the whole of the set: six levels, ordered,
 * with no `silly`, no `verbose` and no caller-defined additions. A fixed set
 * is what lets `LOG_LEVEL` be validated at startup, `isEnabled` be a
 * comparison rather than a lookup, and a future OpenTelemetry bridge map each
 * one to a severity number without a table of synonyms.
 */
export type Level = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** The levels in order, least severe first — what `isEnabled` compares through. */
export const LEVELS: readonly Level[] = ["trace", "debug", "info", "warn", "error", "fatal"];

/**
 * What a line carries besides its message: a flat record of scalars.
 *
 * Flat and scalar on purpose. A structured line is queried by field in the
 * system that receives it, and a nested object is where a field's name stops
 * being stable (`user.id` on one line, `user: { id }` on another); an
 * `unknown` value is where a logger starts stringifying whatever it is
 * handed, which is how a log call becomes the thing that throws. Anything
 * else is the caller's to render — and a failure has a channel of its own,
 * `cause`, which the implementation normalises.
 */
export type Attributes = Readonly<Record<string, string | number | boolean | undefined>>;

/**
 * The application's logger, as a port.
 *
 * Deliberately unlike NestJS's `Logger`, and each difference is a defect
 * this shape does not have:
 *
 * - **A port, not a class.** Nothing is `new`ed, nothing is static, and
 *   nothing is global: a test provides its own, and `Provider(Logger)` is the
 *   only way one is bound. There is no `useLogger` to reach past DI with.
 * - **`with` returns a logger; it never mutates.** Nest's `setContext` writes
 *   to the instance every caller shares, so two request scopes racing it
 *   interleave each other's context. A child here is a value.
 * - **One argument order, and every level can carry a failure.** Six methods,
 *   one shape: `(message, attributes?, cause?)`. A logger whose `error` took
 *   its cause second and whose `warn` took none at all made a caller remember
 *   which arm it was in, and pushed every retryable failure up to `error` to
 *   keep its reason.
 * - **No `any`, and no printf.** `Attributes` is a flat record of scalars —
 *   the shape a log backend can index — and a failure goes in `cause`, which
 *   the implementation normalises (an `Error`'s `message` and `stack` are
 *   non-enumerable, so `JSON.stringify` alone loses exactly the part worth
 *   keeping).
 * - **It cannot throw.** A logger that throws turns an observability problem
 *   into an outage; every implementation this package ships swallows its own
 *   failures, the same rule the kernel's `safeSink` applies to an event sink.
 * - **Correlation is not the caller's job.** The default implementation reads
 *   `currentUnit()` per call, so every line inside a unit carries its
 *   `traceId` — and reading it *per call* rather than at construction is what
 *   makes one application-scope logger correct for every unit.
 *
 * Synchronous `void`, not an `AsyncResult`: a log call is fire-and-forget by
 * definition — a caller who awaited it would be waiting on I/O to decide
 * nothing — and this package's thesis-6 exemption is exactly that. Delivery is
 * the implementation's problem, and a lost line is not a modeled error.
 */
export class Logger extends Port("Logger")<LoggerService> {}

/**
 * Every method takes the same three arguments in the same order, including the
 * six that name their own level: `(message, attributes?, cause?)`.
 *
 * Uniform on purpose, and it was not at first. `error(message, cause,
 * attributes)` read better at the call site that always has a cause and made
 * every OTHER call site remember which arm it was in — and it left `warn` with
 * nowhere to put one, so a retryable failure (a broker that refused a publish,
 * which comes back) had to be logged at `error` purely to keep the reason.
 * A failure is not a property of severity: an `info` line reporting a recovered
 * fault carries one too. The cost is `logger.error("boom", undefined, cause)`
 * for a failure with nothing else to say, which is rare — a line worth writing
 * almost always has an id to write with it.
 */
export type LoggerService = {
  readonly log: (level: Level, message: string, attributes?: Attributes, cause?: unknown) => void;
  readonly trace: (message: string, attributes?: Attributes, cause?: unknown) => void;
  readonly debug: (message: string, attributes?: Attributes, cause?: unknown) => void;
  readonly info: (message: string, attributes?: Attributes, cause?: unknown) => void;
  readonly warn: (message: string, attributes?: Attributes, cause?: unknown) => void;
  /** `cause` is the failure itself — an `Error`, an `unthrown` `Err`'s error, a rejected value. */
  readonly error: (message: string, attributes?: Attributes, cause?: unknown) => void;
  readonly fatal: (message: string, attributes?: Attributes, cause?: unknown) => void;
  /** A logger carrying `attributes` on every line it writes, on top of this one's. Never mutates this one. */
  readonly with: (attributes: Attributes) => LoggerService;
  /** Whether a line at `level` would be written — for a payload expensive enough to be worth not building. */
  readonly isEnabled: (level: Level) => boolean;
};

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
