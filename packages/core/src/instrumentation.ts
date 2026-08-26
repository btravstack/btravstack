import { Port } from "@btravstack/di";

/**
 * One package's offer of an OpenTelemetry instrumentation.
 *
 * **`load` is async, and returns `undefined` rather than failing, because the
 * package supplying the instrumentation is an OPTIONAL peer.** A starter cannot
 * know at composition time whether the consumer installed it, so it contributes
 * the ATTEMPT and the collector decides what to do with nothing — which is what
 * lets `@btravstack/prisma` declare engine tracing without making every
 * consumer install `@prisma/instrumentation`.
 *
 * The instrumentation itself is `unknown` here on purpose. Naming
 * OpenTelemetry's `Instrumentation` would put the vendor in the package every
 * other one peers on — the same reason `Tracer` and `Meter` are declared as
 * narrowings rather than as OTel's own types. The collector
 * (`@btravstack/observability/otel`) is where the vendor is already a
 * dependency, so that is where the cast belongs.
 */
export type OtelInstrumentation = {
  /** Named so a collector can say what it registered, and what it could not load. */
  readonly name: string;
  readonly load: () => Promise<unknown>;
};

/**
 * The set port a package contributes its instrumentation to.
 *
 * Nothing collects it unless an OTel SDK is composed, which is the point: a
 * starter DECLARES what it can instrument, and composing
 * `@btravstack/observability/otel` is what turns the declarations on. A graph
 * without it registers nothing and pays nothing — the Spring Boot starter
 * shape, in one port.
 */
export class Instrumentations extends Port.many("Instrumentations")<OtelInstrumentation> {}
