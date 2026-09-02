import { Observers, noObserver } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";

import { instrument } from "./instrument.js";
import { Mailer, MailerBackend } from "./mailer.js";

export type MailerOptions<E, N> = {
  /**
   * The adapter module: `recordingMailer(recorder)` from this entry point,
   * `smtpMailer()` from `@btravstack/mailer/smtp`, or one an application
   * wrote itself over `MailerBackend`.
   */
  readonly adapter: Module<MailerBackend, E, N>;
};

/**
 * The mailer starter: an adapter, and `Mailer` provided from it.
 *
 * ```ts
 * mailer({ adapter: smtpMailer() });
 * ```
 *
 * **Two ports, because di allows one provider per port per graph**: the port an
 * application depends on must not be the one an adapter provides, which is what
 * lets this function be the seam.
 *
 * **There is no `instrumented` flag.** Every send is handed to whatever
 * contributed to `Observers`; a graph that composed no observability has only
 * this module's own no-op member, so it costs one call per send and nothing
 * else. What rides the signals is the ENVELOPE — a recipient COUNT rather than
 * the addresses, since a recipient list is personal data.
 */
export const mailer = <E, N>({ adapter }: MailerOptions<E, N>): Module<Mailer, E, N> =>
  Module("Mailer")({
    imports: [adapter],
    provides: [
      // The no-op member, so the set this module reads is never the empty
      // dependency di refuses: a graph composing no observability still starts.
      Provider.member(Observers)({ inject: {}, value: noObserver }),
      Provider(Mailer)({
        inject: { backend: MailerBackend, observers: Observers },
        sync: ({ backend, observers }) => instrument(backend, observers),
      }),
    ],
    exports: [Mailer],
  } as never) as unknown as Module<Mailer, E, N>;
