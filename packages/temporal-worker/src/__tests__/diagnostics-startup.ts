import diagnosticsChannel from "node:diagnostics_channel";

import type { DiagnosticPolicy, LoggerService } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { Runtime } from "@temporalio/worker";
import { ErrAsync, OkAsync, TaggedError } from "unthrown";

import { installTemporalDiagnostics, withTemporalDiagnostics } from "../diagnostics.js";

const mode = process.argv[1];
let sockets = 0;
let released = 0;
diagnosticsChannel.subscribe("net.client.socket", () => {
  sockets++;
});

const discard = () => undefined;
const logger: LoggerService = {
  trace: discard,
  debug: discard,
  info: discard,
  warn: discard,
  error: discard,
  fatal: discard,
  with: () => logger,
  isEnabled: () => false,
};
const diagnostics: DiagnosticPolicy = {
  message: () => "diagnostic",
  attributes: () => ({}),
  cause: () => undefined,
};
const options = { logger, diagnostics };
const previous = Runtime.defaultOptions;
const cause = new Error("synthetic startup defect");

class SyntheticCredentialsUnavailable extends TaggedError("SyntheticCredentialsUnavailable") {
  override message = "synthetic credential acquisition refused";
}

class OwnedResource extends Port("OwnedResource")<object> {}
class RejectedResource extends Port("RejectedResource")<object> {}

const root = Module("SyntheticStartup")({
  provides: [
    Provider(OwnedResource)({
      inject: {},
      acquire: () => OkAsync({}),
      release: async () => {
        released++;
      },
    }),
    Provider(RejectedResource)({
      inject: { owner: OwnedResource },
      acquire: () => {
        if (mode === "success") return OkAsync({});
        if (mode === "defect") {
          return OkAsync({}).map(() => {
            // oxlint-disable-next-line unthrown/no-throw -- the subject is a DI acquisition defect before any native connection
            throw cause;
          });
        }
        return ErrAsync(new SyntheticCredentialsUnavailable());
      },
      release: async () => undefined,
    }),
  ],
  exports: [RejectedResource],
});

const work = () => {
  if (mode === "sync-defect") {
    // oxlint-disable-next-line unthrown/no-throw -- the subject is a callback defect before its scoped operation can start
    throw cause;
  }
  return Module.scoped(root, () => OkAsync("served"));
};

if (mode === "legacy-refusal") installTemporalDiagnostics(options).get();
const result = await (mode === "legacy-refusal" ? work() : withTemporalDiagnostics(options, work));
const outcome = result.match({
  ok: (value) => ({ tag: "Ok", value }),
  errCases: (matcher) =>
    matcher.with({ _tag: "SyntheticCredentialsUnavailable" }, (error) => ({
      tag: "Err",
      code: error._tag,
    })),
  defect: (failure) => ({ tag: "Defect", sameCause: failure === cause }),
});
console.log(
  `diagnostics-lifetime ${JSON.stringify({
    outcome,
    released,
    sockets,
    runtimeAbsent: Runtime._instance === undefined,
    defaultsRestored: Runtime.defaultOptions === previous,
  })}`,
);
