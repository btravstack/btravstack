import { Port } from "@btravstack/di";
import { TaggedError, type AsyncResult } from "unthrown";

/**
 * One message: an address list, a subject and a body. No templating, no
 * attachments, no bcc, no headers — each is a decision an application makes
 * with a library of its own, and a port that guessed would be a worse version
 * of the transport's own options.
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
 * The send did not happen. It carries `to` and `subject` and **never the body**:
 * a failure is logged, and a body is the one part of a message that is reliably
 * somebody's personal data.
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
 * The port an application depends on. `send` answers when the transport has
 * ACCEPTED the message, which is not the same as delivered — a caller needing
 * delivery semantics asks its provider's webhooks.
 *
 * **Retries are not here.** A failed send is a modeled `MailNotSent`, and what
 * to do about it belongs to the caller's transport, whose own retry budget owns
 * redelivery rather than a policy this package invented.
 */
export class Mailer extends Port("Mailer")<MailerService> {}

/**
 * The port every adapter provides, and the one an application never depends on.
 *
 * di allows one provider per port per graph, so the instrumented composition
 * cannot be a layer over the plain one: an adapter targets this, and `mailer()`
 * turns it into `Mailer`. A spec overrides THIS port.
 */
export class MailerBackend extends Port("MailerBackend")<MailerService> {}
