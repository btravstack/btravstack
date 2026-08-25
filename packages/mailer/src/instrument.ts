import {
  SPAN_STATUS,
  type Counter,
  type LoggerService,
  type MeterService,
  type TracerService,
} from "@btravstack/core";

import type { MailerService } from "./mailer.js";

/**
 * One send, wrapped: a span around it, a count of how it came out, and a log
 * line if it failed.
 *
 * **What rides the signals is the envelope, never the body.** `to` is
 * recorded as a *count* rather than the addresses — a recipient list is
 * personal data and a span is not the place for it — and the subject is
 * carried because it is what an operator recognises a stuck mail by. The
 * body is never touched.
 */
export const instrument = (
  backend: MailerService,
  logger: LoggerService,
  tracer: TracerService,
  meter: MeterService,
): MailerService => {
  // One instrument per scope, read per call: the attributes vary, the counter
  // does not — the same split `createLogger` documents for the ambient record.
  const sends: Counter = meter.createCounter("btravstack.mailer.sends", {
    description: "Mail sends, by outcome",
  });

  return {
    send: (mail) => {
      const span = tracer.startSpan("mailer.send");
      span.setAttributes({
        "btravstack.mail.recipients": mail.to.length,
        "btravstack.mail.subject": mail.subject,
      });

      return (
        backend
          .send(mail)
          .tap(() => {
            sends.add(1, { outcome: "ok" });
            logger.info("mail sent", {
              recipients: mail.to.length,
              subject: mail.subject,
            });
            span.end();
          })
          // `tapFailure`, not an Err-only tap: a transport that throws is a
          // failed send too, and a span left open by it would be worse than
          // the defect.
          .tapFailure((failure) => {
            const cause = failure.tag === "Err" ? failure.error : failure.cause;
            sends.add(1, { outcome: "error" });
            logger.error(
              "the mail could not be sent",
              { recipients: mail.to.length, subject: mail.subject },
              cause,
            );
            span.setStatus({ code: SPAN_STATUS.error });
            span.end();
          })
      );
    },
  };
};
