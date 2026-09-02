import { randomUUID } from "node:crypto";

import { Env } from "@btravstack/config";
import { Module, Provider } from "@btravstack/di";
import { observability, type Line } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";
import { metrics, trace } from "@opentelemetry/api";
import { PeriodicExportingMetricReader, type DataPoint } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace";
import { createTransport } from "nodemailer";
import { ErrAsync, OkAsync, fromSafePromise } from "unthrown";
import { inject, test } from "vitest";

import { MailNotSent, Mailer, MailerBackend, type MailerService } from "../mailer.js";
import { mailer } from "../module.js";
import { mailRecorder, recordingMailer, type MailRecorder } from "../recording.js";
import { smtpMailer, smtpMailerBackend } from "../smtp.js";

/** An adapter that always refuses, so the failure arms are reachable without a broken server. */
const failingBackend: MailerService = {
  send: (mail) =>
    ErrAsync(new MailNotSent({ to: mail.to, subject: mail.subject, reason: "the relay refused" })),
};

export const failingMailer = (): Module<MailerBackend, never, never> =>
  Module("FailingMailer")({
    provides: [Provider(MailerBackend)({ inject: {}, value: failingBackend })],
    exports: [MailerBackend],
  });

/**
 * An adapter that defects rather than failing — a transport throwing where a
 * `Result` was expected, which the port deliberately does not model.
 */
const defectiveBackend: MailerService = {
  send: () =>
    OkAsync().map(() => {
      // oxlint-disable-next-line unthrown/no-throw -- `Defect` has no public constructor, so a throw inside a combinator is the only way to mint one, and reaching the defect arm is the whole point of this fixture
      throw new Error("the transport blew up");
    }),
};

export const defectiveMailer = (): Module<MailerBackend, never, never> =>
  Module("DefectiveMailer")({
    provides: [Provider(MailerBackend)({ inject: {}, value: defectiveBackend })],
    exports: [MailerBackend],
  });

/** One message a spec can send without restating an envelope every time. */
export const aMail = (to: string) => ({
  from: "orders@example.test",
  to: [to],
  subject: "your order",
  text: "thank you",
});

/** What a Mailpit message looks like, narrowed to what the specs read. */
type Delivered = {
  readonly ID: string;
  readonly To: readonly { readonly Address: string }[];
  readonly Cc: readonly { readonly Address: string }[];
  readonly Subject: string;
  /** A count, which is what the summary carries. */
  readonly Attachments: number;
};

export type Instrumented = {
  readonly run: <T>(
    adapter: Module<MailerBackend, never, never>,
    body: (service: MailerService) => PromiseLike<T>,
  ) => Promise<T>;
  readonly spans: () => readonly ReadableSpan[];
  readonly points: () => readonly DataPoint<number>[];
  readonly lines: () => readonly Line[];
};

export type MailerFixtures = {
  /** A recorder and the adapter over it, built together so a spec asserts on what it composed. */
  readonly recorder: MailRecorder;
  /** The recording adapter's service, for a spec that wants no graph. */
  readonly recording: MailerService;
  /** This test's own recipient on the shared server — a UUID, so nothing collides and nothing needs purging. */
  readonly recipient: string;
  /** The SMTP adapter's service, connected for the length of the test. */
  readonly smtp: MailerService;
  /** The SMTP adapter over a relay that is not listening — the failure every deployment eventually meets. */
  readonly unreachable: MailerService;
  /** Reads what Mailpit actually received, by recipient. */
  readonly delivered: (recipient: string) => Promise<readonly Delivered[]>;
  /** The headers of one received message — the only place a passthrough header is visible. */
  readonly headersOf: (id: string) => Promise<Readonly<Record<string, readonly string[]>>>;
  /** An instrumented mailer, and the three signals it emits. */
  readonly instrumented: Instrumented;
};

export const it = test.extend<MailerFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- vitest's fixture signature: one that names no other fixture still takes the destructured first parameter
  recorder: async ({}, use) => {
    await use(mailRecorder());
  },
  recording: async ({ recorder }, use) => {
    const served = await Module.scoped(
      Module("RecordingFixture")({
        imports: [mailer({ adapter: recordingMailer(recorder) })],
        exports: [Mailer],
      }),
      (ctx) => fromSafePromise(use(ctx.get(Mailer))),
    );
    served.get();
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  recipient: async ({}, use) => {
    await use(`${randomUUID()}@example.test`);
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  smtp: async ({}, use) => {
    const env = { SMTP_URL: inject("__TESTCONTAINERS_SMTP_URL__") };
    const served = await Module.scoped(
      Module("SmtpFixture")({
        imports: [smtpMailer()],
        provides: [Provider(Env)({ inject: {}, value: env })],
        exports: [MailerBackend],
      }),
      // `use` runs INSIDE the scope, so the transport the provider opened is
      // closed by the scope closing — the drain's own path, not a teardown
      // of the fixture's.
      (ctx) => fromSafePromise(use(ctx.get(MailerBackend))),
    );

    // A fixture that swallowed a failing scope would leave the test green on
    // a transport that never opened.
    served.getOrThrow();
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  unreachable: async ({}, use) => {
    // Port 1 refuses immediately, so the arm is reached in milliseconds.
    // Mailpit cannot produce it: a catch-all accepts even an empty sender,
    // which makes it a good success fixture and a useless failure one.
    await use(smtpMailerBackend(createTransport("smtp://127.0.0.1:1")));
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  delivered: async ({}, use) => {
    const api = inject("__TESTCONTAINERS_MAILPIT_API__");
    await use(async (recipient) => {
      const response = await fetch(
        `${api}/api/v1/search?query=${encodeURIComponent(`to:${recipient}`)}`,
      );
      const body = (await response.json()) as { readonly messages: readonly Delivered[] };
      return body.messages;
    });
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  headersOf: async ({}, use) => {
    const api = inject("__TESTCONTAINERS_MAILPIT_API__");
    await use(async (id) => {
      const response = await fetch(`${api}/api/v1/message/${id}/headers`);
      return (await response.json()) as Readonly<Record<string, readonly string[]>>;
    });
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  instrumented: async ({}, use) => {
    // The SDK's env defaults would stand up an OTLP log exporter whose
    // shutdown retries a collector that is not there.
    process.env["OTEL_LOGS_EXPORTER"] = "none";

    const exported: ReadableSpan[] = [];
    // An exporter whose memory survives its own shutdown: the in-memory one
    // OTel ships clears exactly when the flush under test delivers.
    const exporter: SpanExporter = {
      export: (spans, resultCallback) => {
        exported.push(...spans);
        resultCallback({ code: 0 });
      },
      shutdown: () => Promise.resolve(),
    };
    const lines: Line[] = [];
    const reader = new PeriodicExportingMetricReader({
      exporter: {
        export: (_metrics, resultCallback) => resultCallback({ code: 0 }),
        forceFlush: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
      },
      exportIntervalMillis: 3_600_000,
    });

    let counted: readonly DataPoint<number>[] = [];
    // Collected INSIDE the scope: closing it shuts the SDK down, and a reader
    // that has been shut down refuses to collect.
    const collect = async (): Promise<void> => {
      const { resourceMetrics } = await reader.collect();
      counted = resourceMetrics.scopeMetrics
        .flatMap((scope) => scope.metrics)
        .filter((metric) => metric.descriptor.name === "btravstack.mail.operations")
        .flatMap((metric) => metric.dataPoints as readonly DataPoint<number>[]);
    };

    const run = async <T>(
      adapter: Module<MailerBackend, never, never>,
      body: (service: MailerService) => PromiseLike<T>,
    ): Promise<T> => {
      const served = await Module.scoped(
        Module("InstrumentedFixture")({
          imports: [
            // No flag: the harness exercises the DEFAULT, which is instrumented.
            mailer({ adapter }),
            // The real starter over a recording sink, not a hand-built logger:
            // the lines are `observability()`'s own observer now, so a fixture
            // that provided only a `Logger` would record nothing.
            observability({ sink: (line) => lines.push(line), level: "debug" }),
            Module("FixtureEnv")({
              provides: [Provider(Env)({ inject: {}, value: {} })],
              exports: [Env],
            }),
            otel({
              spanProcessors: [
                new BatchSpanProcessor({ exporter, scheduledDelayMillis: 3_600_000 }),
              ],
              metricReader: reader,
            }),
          ],
          exports: [Mailer],
        }),
        (ctx) =>
          fromSafePromise(
            Promise.resolve(body(ctx.get(Mailer))).then(async (value) => {
              await collect();
              return value;
            }),
          ),
      );

      // `get`, not `getOrThrow`: this graph's error channel is `never`.
      return served.getOrThrow();
    };

    await use({ run, spans: () => exported, points: () => counted, lines: () => lines });

    // The api's globals register ONCE per process; without this, only the
    // first test's SDK would ever receive anything.
    trace.disable();
    metrics.disable();
    delete process.env["OTEL_LOGS_EXPORTER"];
  },
});
