import { Port } from "@btravstack/di";
import { TaggedError, type AsyncResult } from "unthrown";

/**
 * One file on a message. `content` is bytes or a string and never a path or a
 * stream: a port that took either would be asking every adapter to own a
 * filesystem and a lifetime, where a caller that has a file can read it.
 */
export type MailAttachment = {
  readonly filename: string;
  readonly content: Uint8Array | string;
  /** Defaults to whatever the adapter infers from `filename`. */
  readonly contentType?: string;
};

/**
 * One message: the envelope, a subject and a body. No templating — that is an
 * application's decision with a library of its own — but everything an envelope
 * carries, because an invoice mail with an attachment is roughly the second one
 * a service sends, and a port that cannot carry it gets bypassed rather than
 * extended, losing the recorder and the instrumentation with it.
 */
export type Mail = {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject: string;
  /** The plain-text body. Required: a mail with only HTML is a mail some clients cannot read. */
  readonly text: string;
  readonly html?: string;
  readonly attachments?: readonly MailAttachment[];
  /** Extra headers, verbatim. What an adapter already sets it sets — this does not replace an envelope field. */
  readonly headers?: Readonly<Record<string, string>>;
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
