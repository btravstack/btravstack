import { Logger, Meter, Tracer } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";

import { instrument } from "./instrument.js";
import { Mailer, MailerBackend } from "./mailer.js";

export type MailerOptions<E, N, Instrumented extends boolean> = {
  /**
   * The adapter module: `recordingMailer(recorder)` from this entry point,
   * `smtpMailer()` from `@btravstack/mailer/smtp`, or one an application
   * wrote itself over `MailerBackend`.
   */
  readonly adapter: Module<MailerBackend, E, N>;
  /**
   * Span, count and log every send. **Default `true`**, `false` opts out.
   *
   * On by default because telemetry that is missing is discovered during an
   * incident. The cost is stated rather than hidden: instrumenting puts
   * `Logger`, `Meter` and `Tracer` in this module's `Needs`, so a root without
   * `observability()` and `otel()` gets a compile error naming all three.
   */
  readonly instrumented?: Instrumented;
};

/**
 * The mailer starter: an adapter, and `Mailer` provided from it —
 * instrumented or not, decided here at the composition root.
 *
 * ```ts
 * mailer({ adapter: smtpMailer() });                      // spans, counts, log lines
 * mailer({ adapter: smtpMailer(), instrumented: false }); // just a mailer
 * ```
 *
 * **Two ports, because di allows one provider per port per graph**: the port an
 * application depends on must not be the one an adapter provides, which is also
 * why instrumentation is a flag on the composition rather than a wrapper.
 */
export const mailer = <E, N, Instrumented extends boolean = true>({
  adapter,
  instrumented,
}: MailerOptions<E, N, Instrumented>): Module<
  Mailer,
  E,
  Instrumented extends true ? N | Logger | Meter | Tracer : N
> =>
  // One signature, two graphs — so the return type is the conditional above
  // and the implementation casts once, a value-level branch reporting a
  // type-level one.
  (instrumented !== false
    ? Module("InstrumentedMailer")({
        needs: [Logger, Meter, Tracer],
        imports: [adapter],
        provides: [
          Provider(Mailer)({
            inject: { backend: MailerBackend, logger: Logger, tracer: Tracer, meter: Meter },
            sync: ({ backend, logger, tracer, meter }) =>
              instrument(backend, logger, tracer, meter),
          }),
        ],
        exports: [Mailer],
      })
    : Module("Mailer")({
        imports: [adapter],
        provides: [
          Provider(Mailer)({ inject: { backend: MailerBackend }, sync: ({ backend }) => backend }),
        ],
        exports: [Mailer],
      })) as unknown as Module<
    Mailer,
    E,
    Instrumented extends true ? N | Logger | Meter | Tracer : N
  >;
