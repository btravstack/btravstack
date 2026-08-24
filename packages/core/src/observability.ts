import { Port } from "@btravstack/di";

/**
 * The severity of one line, and the whole of the set: six levels, ordered,
 * with no `silly`, no `verbose` and no caller-defined additions. A fixed set
 * is what lets `LOG_LEVEL` be validated at startup, `isEnabled` be a
 * comparison rather than a lookup, and an OpenTelemetry bridge map each one to
 * a severity number without a table of synonyms.
 */
export type Level = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** The levels in order, least severe first — what `isEnabled` compares through. */
export const LEVELS: readonly Level[] = ["trace", "debug", "info", "warn", "error", "fatal"];

/**
 * What a line, a span or a measurement carries besides itself: a flat record
 * of scalars.
 *
 * Flat and scalar on purpose. A structured line is queried by field in the
 * system that receives it, and a nested object is where a field's name stops
 * being stable (`user.id` on one line, `user: { id }` on another); an
 * `unknown` value is where a logger starts stringifying whatever it is
 * handed, which is how a log call becomes the thing that throws. Anything
 * else is the caller's to render — and a failure has a channel of its own,
 * `cause`, which an implementation normalises.
 */
export type Attributes = Readonly<Record<string, string | number | boolean | undefined>>;

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

/**
 * The application's logger, as a port.
 *
 * Declared **here**, in the kernel, and implemented in
 * `@btravstack/observability`. The split is the same one every port in this
 * stack makes, applied to the framework's own packages: a contract every
 * package may depend on has to be reachable without installing an
 * implementation, and the kernel is the one package all of them already peer
 * on. It also sits on a concept the kernel owns — the correlation an
 * implementation stamps on every line (`UnitRecord`'s `unitId`, `traceId` and
 * `tenantId`) is the kernel's ambient record, and `currentUnit()` is the
 * kernel's API.
 *
 * Deliberately unlike NestJS's `Logger`, and each difference is a defect this
 * shape does not have:
 *
 * - **A port, not a class.** Nothing is `new`ed, nothing is static, and
 *   nothing is global: a test provides its own, and `Provider(Logger)` is the
 *   only way one is bound. There is no `useLogger` to reach past DI with.
 * - **`with` returns a logger; it never mutates.** Nest's `setContext` writes
 *   to the instance every caller shares, so two request scopes racing it
 *   interleave each other's context. A child here is a value.
 * - **One argument order, and every level can carry a failure.**
 * - **No `any`, and no printf.** `Attributes` is a flat record of scalars.
 * - **It cannot throw.** A logger that throws turns an observability problem
 *   into an outage; every implementation this family ships swallows its own
 *   failures, the same rule the kernel's `safeSink` applies to an event sink.
 * - **Correlation is not the caller's job.** The shipped implementation reads
 *   `currentUnit()` per call, so every line inside a unit carries its
 *   `traceId` — and reading it *per call* rather than at construction is what
 *   makes one application-scope logger correct for every unit.
 *
 * Synchronous `void`, not an `AsyncResult`: a log call is fire-and-forget by
 * definition — a caller who awaited it would be waiting on I/O to decide
 * nothing — and this is thesis 6's one deliberate exemption. Delivery is the
 * implementation's problem, and a lost line is not a modeled error.
 */
export class Logger extends Port("Logger")<LoggerService> {}

/** A span's outcome: unset until something says otherwise, then `ok` or `error`. */
export const SPAN_STATUS = { unset: 0, ok: 1, error: 2 } as const;

/** The three codes {@link SPAN_STATUS} names, as the type a {@link Span} takes. */
export type SpanStatusCode = (typeof SPAN_STATUS)[keyof typeof SPAN_STATUS];

/**
 * One span, narrowed to what a framework package does with it: label it,
 * say how it ended, end it.
 *
 * The numbers are OpenTelemetry's own (`UNSET`, `OK`, `ERROR`), so an OTel
 * span satisfies this structurally and no translation sits in between — the
 * contract is a **narrowing** of the ecosystem's shape, not a parallel
 * vocabulary. What it deliberately leaves out is everything only a tracing
 * implementation needs: the span context, links, events, the recording flag.
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
 * The application's tracer, as a port.
 *
 * Declared without naming OpenTelemetry, for the reason every port in this
 * stack is declared without naming its adapter: a port typed as a vendor's
 * type points the dependency arrow outwards, and the whole family would then
 * install that vendor to state a dependency it might never use.
 * `@btravstack/observability/otel` is the adapter that satisfies it, and it
 * is not the only one that could.
 */
export class Tracer extends Port("Tracer")<TracerService> {}

/** A monotonic count. */
export type Counter = { readonly add: (value: number, attributes?: Attributes) => void };

/** A distribution of measurements. */
export type Histogram = { readonly record: (value: number, attributes?: Attributes) => void };

/**
 * What a {@link Meter} does: mint the two instruments a framework package
 * needs.
 *
 * Two, not the ecosystem's full set: a gauge and an up-down counter are things
 * an application declares about its own domain, and it reaches the vendor's
 * meter for those the way it reaches any other adapter. A framework package
 * counts what happened and measures how long it took.
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
