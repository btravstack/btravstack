import { Port } from "@btravstack/di";

/**
 * The severity of one line, and the whole of the set: six levels, ordered, with
 * no caller-defined additions — which is what lets `LOG_LEVEL` be validated at
 * startup and `isEnabled` be a comparison rather than a lookup.
 */
export type Level = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** The levels in order, least severe first — what `isEnabled` compares through. */
export const LEVELS: readonly Level[] = ["trace", "debug", "info", "warn", "error", "fatal"];

/**
 * What a line, a span or a measurement carries besides itself: a flat record of
 * scalars.
 *
 * Flat and scalar on purpose. A nested object is where a field's name stops
 * being stable, and an `unknown` value is where a logger starts stringifying
 * whatever it is handed — which is how a log call becomes the thing that
 * throws. A failure has a channel of its own, `cause`.
 */
export type Attributes = Readonly<Record<string, string | number | boolean | undefined>>;

/**
 * Every method takes the same three arguments in the same order:
 * `(message, attributes?, cause?)`.
 *
 * Uniform on purpose. A failure is not a property of severity — an `info` line
 * reporting a recovered fault carries one too — so every level can take a
 * `cause`, at the cost of `logger.error("boom", undefined, cause)` for a
 * failure with nothing else to say.
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

/**
 * The application's logger, as a port — declared here and implemented in
 * `@btravstack/observability`, because a contract every package may depend on
 * has to be reachable without installing an implementation, and because the
 * correlation an implementation stamps per line is the kernel's own ambient
 * record.
 *
 * An implementation must not throw: a logger that throws turns an observability
 * problem into an outage. Synchronous `void`, not an `AsyncResult` — thesis 6's
 * one deliberate exemption, since a lost line is not a modeled error.
 */
export class Logger extends Port("Logger")<LoggerService> {}

/** A span's outcome: unset until something says otherwise, then `ok` or `error`. */
export const SPAN_STATUS = { unset: 0, ok: 1, error: 2 } as const;

/** The three codes {@link SPAN_STATUS} names, as the type a {@link Span} takes. */
export type SpanStatusCode = (typeof SPAN_STATUS)[keyof typeof SPAN_STATUS];

/**
 * One span, narrowed to what a framework package does with it: label it, say
 * how it ended, end it. The numbers are OpenTelemetry's own, so an OTel span
 * satisfies this structurally with no translation in between.
 */
export type Span = {
  readonly setAttributes: (attributes: Attributes) => unknown;
  readonly setStatus: (status: {
    readonly code: SpanStatusCode;
    readonly message?: string;
  }) => unknown;
  readonly end: () => void;
};

/** What a {@link Tracer} does: start a span, by name. */
export type TracerService = { readonly startSpan: (name: string) => Span };

/**
 * The application's tracer, as a port — declared without naming OpenTelemetry,
 * because a port typed as a vendor's type points the dependency arrow outwards
 * and makes the whole family install that vendor.
 */
export class Tracer extends Port("Tracer")<TracerService> {}

/** A monotonic count. */
export type Counter = { readonly add: (value: number, attributes?: Attributes) => void };

/** A distribution of measurements. */
export type Histogram = { readonly record: (value: number, attributes?: Attributes) => void };

/**
 * What a {@link Meter} does: mint the two instruments a framework package needs
 * — it counts what happened and measures how long it took. A gauge is something
 * an application declares about its own domain, reaching the vendor's meter for
 * it as it would any other adapter.
 */
export type MeterService = {
  readonly createCounter: (
    name: string,
    options?: { readonly description?: string; readonly unit?: string },
  ) => Counter;
  readonly createHistogram: (
    name: string,
    options?: { readonly description?: string; readonly unit?: string },
  ) => Histogram;
};

/** The application's meter, as a port. See {@link Tracer} for why it does not name a vendor. */
export class Meter extends Port("Meter")<MeterService> {}
