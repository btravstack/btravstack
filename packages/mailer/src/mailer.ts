import { Port } from "@btravstack/di";
import { TaggedError, type AsyncResult } from "unthrown";

/**
 * One message.
 *
 * Deliberately small: an address list, a subject and a body. No templating,
 * no attachments, no bcc, no headers — each of those is a decision an
 * application makes with a library of its own, and a port that guessed at
 * them would be a worse version of `nodemailer`'s own options with none of
 * its coverage.
 */
export type Mail = {
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  /** The plain-text body. Required: a mail with only HTML is a mail some clients cannot read. */
  readonly text: string;
  readonly html?: string;
};

/**
 * The send did not happen.
 *
 * It carries `to` and `subject` and **never the body**: a failure is logged,
 * and a body is the one part of a message that is reliably somebody's
 * personal data. `reason` is the transport's own words, for an operator
 * reading the line.
 */
export class MailNotSent extends TaggedError("MailNotSent")<{
  readonly to: readonly string[];
  readonly subject: string;
  readonly reason: string;
}> {}

export type MailerService = {
  readonly send: (mail: Mail) => AsyncResult<void, MailNotSent>;
};

/**
 * The port an application depends on.
 *
 * `send` answers when the transport has accepted the message, which is not
 * the same as delivered — nothing this side of a mailbox can promise that.
 * A caller that needs delivery semantics is asking its provider's webhooks,
 * not this port.
 *
 * **Retries are not here.** A failed send comes back as a modeled
 * `MailNotSent`, and what to do about it is the caller's transport's job:
 * `examples/order-amqp-worker` answers a `RetryableError`, so the broker's
 * own retry budget owns redelivery rather than a policy this package
 * invented.
 */
export class Mailer extends Port("Mailer")<MailerService> {}

/**
 * The port every adapter provides, and the one an application never depends
 * on.
 *
 * The same split `@btravstack/cache` makes, for the same reason: di allows
 * one provider per port per graph, so the instrumented composition cannot be
 * a layer over the plain one. An adapter targets this; `mailer()` turns it
 * into `Mailer`. A spec overrides THIS port to put a recording adapter under
 * the real root.
 */
export class MailerBackend extends Port("MailerBackend")<MailerService> {}
