import { observe, type Operation, type Settle } from "@btravstack/core";

import type { MailerService } from "./mailer.js";

/**
 * One send, handed to every observer the graph composed.
 *
 * **What rides the signals is the envelope, never the body.** The recipients
 * are recorded as a COUNT rather than as addresses, since a recipient list is
 * personal data; the subject is what an operator recognises a stuck mail by,
 * and it is a DETAIL — on the span and the line, never on an instrument, where
 * one subject would be one time series.
 */
export const instrument = (
  backend: MailerService,
  observers: readonly ((operation: Operation) => Settle)[],
): MailerService => ({
  send: (mail) => {
    const settle = observe(observers, {
      component: "mail",
      name: "send",
      attributes: { operation: "send" },
      details: {
        "btravstack.mail.recipients": mail.to.length,
        "btravstack.mail.subject": mail.subject,
      },
    });

    return (
      backend
        .send(mail)
        .tap(() => settle({ outcome: "ok" }))
        // `tapFailure`, not an Err-only tap: a transport that throws is a
        // failed send too, and it would leave the observation unsettled.
        .tapFailure((failure) =>
          settle({
            outcome: "error",
            cause: failure.tag === "Err" ? failure.error : failure.cause,
          }),
        )
    );
  },
});
