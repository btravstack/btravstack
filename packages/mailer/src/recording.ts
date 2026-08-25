import { Module, Provider } from "@btravstack/di";
import { OkAsync } from "unthrown";

import { MailerBackend, type Mail, type MailerService } from "./mailer.js";

/**
 * What a spec asserts against: the mails that would have been sent.
 *
 * `record` is the adapter's half and `sent`/`only` are the test's, on one
 * object rather than two, so nothing has to reach into an array somebody
 * else owns. The shape of the reading half is
 * `@btravstack/observability`'s `Recorder`: `only()` throws unless there is
 * exactly one, because a test that read it before the send it exists to
 * capture is a broken test and the loudest answer is the right one.
 */
export type MailRecorder = {
  readonly record: (mail: Mail) => void;
  readonly sent: () => readonly Mail[];
  readonly only: () => Mail;
};

export const mailRecorder = (): MailRecorder => {
  const mails: Mail[] = [];
  return {
    record: (mail) => {
      mails.push(mail);
    },
    sent: () => mails,
    only: () => {
      const [first] = mails;
      if (first === undefined || mails.length !== 1) {
        // oxlint-disable-next-line unthrown/no-throw -- a fixture read before the mail it exists to capture is a broken test, and the loudest possible answer is the right one
        throw new Error(`expected exactly one mail, got ${mails.length}`);
      }
      return first;
    },
  };
};

/**
 * The testable-by-default adapter: it sends nothing and keeps everything.
 *
 * This is the half of a mailer that matters most in a test suite — the
 * question is almost never "did SMTP work", it is "would this code have sent
 * the right message" — which is why it ships beside the real transport
 * rather than being left for every application to write again.
 *
 * It cannot fail. A spec that needs the failure arm composes an adapter of
 * its own answering `MailNotSent`; making this one configurable would put a
 * policy in a fixture whose whole value is having none.
 */
export const recordingMailerBackend = (recorder: MailRecorder): MailerService => ({
  send: (mail) => {
    recorder.record(mail);
    return OkAsync();
  },
});

/** The adapter as a provider, which is the shape `@btravstack/testing`'s `overridden` takes. */
export const recordingMailerProvider = (recorder: MailRecorder) =>
  Provider(MailerBackend)({}, { sync: () => recordingMailerBackend(recorder) });

/** The adapter as a module, which is the shape `mailer({ adapter })` takes. */
export const recordingMailer = (recorder: MailRecorder): Module<MailerBackend, never, never> =>
  Module("RecordingMailer")({
    provides: [recordingMailerProvider(recorder)],
    exports: [MailerBackend],
  });
