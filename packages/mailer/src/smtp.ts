import { Config, Env, type ConfigInvalid } from "@btravstack/config";
import type { Scope } from "@btravstack/di";
import { Module, Port, Provider } from "@btravstack/di";
import { createTransport, type Transporter } from "nodemailer";
import { fromPromise, fromSafePromise } from "unthrown";

import { MailNotSent, MailerBackend, type MailerService } from "./mailer.js";

/** What the graph bound from the environment for the SMTP adapter. */
export class MailerConfig extends Port("MailerConfig")<{ readonly url: string }> {}

/**
 * `SMTP_URL`, required. One URL rather than a host/port/user/password quartet:
 * it is what the transport takes and what a deployment already stores as one
 * secret. An unset variable is a `ConfigInvalid` naming it, at graph build.
 */
export const smtpSchema = Config.object({ url: Config.string("SMTP_URL") });

/**
 * The transport, as a port of its own: a resourceful provider is handed back the
 * service it acquired, and a mailer's one method is not something you can close
 * — so the transporter rides the graph and the scope closing closes its pool.
 */
class SmtpTransport extends Port("SmtpTransport")<Transporter> {}

/**
 * The adapter's service over a transport. A rejected send becomes a modeled
 * `MailNotSent` carrying the envelope and the transport's own words — never the
 * body.
 */
export const smtpMailerBackend = (transport: Transporter): MailerService => ({
  send: (mail) =>
    fromPromise(
      transport.sendMail({
        from: mail.from,
        to: [...mail.to],
        ...(mail.cc === undefined ? {} : { cc: [...mail.cc] }),
        ...(mail.bcc === undefined ? {} : { bcc: [...mail.bcc] }),
        subject: mail.subject,
        text: mail.text,
        ...(mail.html === undefined ? {} : { html: mail.html }),
        ...(mail.headers === undefined ? {} : { headers: { ...mail.headers } }),
        ...(mail.attachments === undefined
          ? {}
          : {
              attachments: mail.attachments.map((attachment) => ({
                filename: attachment.filename,
                // `Buffer.from` over both arms: nodemailer takes a string as a
                // body to encode, and the port's string is already the bytes.
                content: Buffer.from(attachment.content),
                ...(attachment.contentType === undefined
                  ? {}
                  : { contentType: attachment.contentType }),
              })),
            }),
      }),
      (cause) =>
        new MailNotSent({
          to: mail.to,
          subject: mail.subject,
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    ).map(() => undefined),
});

/**
 * The SMTP adapter: one pooled transport, opened with the scope and closed with
 * it, and `MailerBackend` over it. `nodemailer` is an **optional** peer reached
 * only through this subpath.
 */
export const smtpMailer = (): Module<MailerBackend, ConfigInvalid, Env | Scope> =>
  Module("SmtpMailer")({
    needs: [Env],
    provides: [
      Config.provider(MailerConfig)(smtpSchema),
      Provider(SmtpTransport)({
        inject: { config: MailerConfig },
        acquire: ({ config }) => fromSafePromise(Promise.resolve(createTransport(config.url))),
        release: (transport) => {
          transport.close();
        },
      }),
      Provider(MailerBackend)({
        inject: { transport: SmtpTransport },
        sync: ({ transport }) => smtpMailerBackend(transport),
      }),
    ],
    exports: [MailerBackend],
  });
