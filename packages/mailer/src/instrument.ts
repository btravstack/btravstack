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
 * **What rides the signals is the envelope, never the body.** `to` is recorded
 * as a COUNT rather than the addresses, since a recipient list is personal data;
 * the subject is what an operator recognises a stuck mail by.
 */
export const instrument = (
  backend: MailerService,
  logger: LoggerService,
  tracer: TracerService,
  meter: MeterService,
): MailerService => {
  // One instrument per scope, read per call: the attributes vary, the counter
  // does not.
  const operations: Counter = meter.createCounter("btravstack.mail.operations", {
    description: "Mail operations, by operation and outcome",
  });

  return {
    send: (mail) => {
      const span = tracer.startSpan("mail.send");
      span.setAttributes({
        "btravstack.mail.recipients": mail.to.length,
        "btravstack.mail.subject": mail.subject,
      });

      return (
        backend
          .send(mail)
          .tap(() => {
            operations.add(1, { operation: "send", outcome: "ok" });
            logger.info("mail sent", {
              recipients: mail.to.length,
              subject: mail.subject,
            });
            span.end();
          })
          // `tapFailure`, not an Err-only tap: a transport that throws is a
          // failed send too, and it would leave the span open.
          .tapFailure((failure) => {
            const cause = failure.tag === "Err" ? failure.error : failure.cause;
            operations.add(1, { operation: "send", outcome: "error" });
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
