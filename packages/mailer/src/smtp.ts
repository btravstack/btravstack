import { Config, Env, type ConfigInvalid } from "@btravstack/config";
import { HealthCheckFailed, HealthChecks } from "@btravstack/core";
import type { Scope } from "@btravstack/di";
import { Module, Port, Provider } from "@btravstack/di";
import { createTransport, type Transporter } from "nodemailer";
import { fromPromise, fromSafePromise, type AsyncResult } from "unthrown";

/**
 * How long the health check waits for the relay before calling it unhealthy.
 *
 * `runHealthChecks` has no deadline of its own — a check is trusted to answer —
 * and nodemailer's own defaults do not bound this one usefully: an unanswering
 * relay can hold `verify()` for its greeting timeout, and a probe that hangs is
 * a probe an orchestrator times out instead of reading. Five seconds sits under
 * a stock `periodSeconds`, so a slow relay is reported rather than skipped.
 */
const HEALTH_TIMEOUT_MS = 5_000;

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
                // A string is handed over as it is — nodemailer encodes it —
                // and bytes ride a Buffer VIEW over the same memory, so an
                // attachment is never copied on its way out.
                content:
                  typeof attachment.content === "string"
                    ? attachment.content
                    : Buffer.from(
                        attachment.content.buffer,
                        attachment.content.byteOffset,
                        attachment.content.byteLength,
                      ),
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
 * `transport.verify()`, but never longer than `ms`, as a `HealthCheckFailed`
 * either way.
 *
 * The timer is `unref`ed and cleared on the winning branch: a probe must not
 * keep the event loop alive, and a `/healthz` served during a drain must not
 * hold the process open past it. **The losing `verify()` is adopted and
 * silenced** — it cannot be cancelled (nodemailer offers no handle), so its
 * later rejection would surface as an unhandled one, in a process that has
 * already reported the timeout.
 *
 * @internal Exported for `smtp.spec.ts` alone — the timeout arm needs a relay
 * that never answers, which no real one reliably is, and a five-second wait in
 * the suite to reach it otherwise.
 */
export const verifyWithin = (
  transport: Transporter,
  ms: number,
): AsyncResult<void, HealthCheckFailed> => {
  let timer: NodeJS.Timeout | undefined;
  const verifying = transport.verify().then((): void => undefined);
  verifying.catch(() => undefined);
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`the relay did not answer within ${ms} ms`)), ms);
    timer.unref();
  });
  return fromPromise(
    Promise.race([verifying, timeout]).finally(() => {
      clearTimeout(timer);
    }),
    (cause: unknown) =>
      new HealthCheckFailed({
        reason: cause instanceof Error ? cause.message : "the relay did not answer",
      }),
  );
};

/**
 * The SMTP adapter: one pooled transport, opened with the scope and closed with
 * it, and `MailerBackend` over it. `nodemailer` is an **optional** peer reached
 * only through this subpath.
 */
export const smtpMailer = (): Module<MailerBackend | HealthChecks, ConfigInvalid, Env | Scope> =>
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
      Provider.member(HealthChecks)({
        inject: { transport: SmtpTransport },
        sync: ({ transport }) => ({
          name: "mailer",
          check: () => verifyWithin(transport, HEALTH_TIMEOUT_MS),
        }),
      }),
    ],
    exports: [MailerBackend, HealthChecks],
  });
