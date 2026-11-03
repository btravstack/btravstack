import { Connection } from "@temporalio/client";
import { ErrAsync, P, TaggedError, fromPromise, fromThrowable, type AsyncResult } from "unthrown";

import { connectionOptions, type Credentials } from "./connection-security.js";

/** The Temporal service did not answer while the client connection opened. */
export class TemporalClientUnreachable extends TaggedError("TemporalClientUnreachable")<{
  readonly address: string;
  readonly cause: unknown;
}> {
  override message = `the Temporal service at ${this.address} did not answer`;
}

export const connect = (
  address: string,
  credentials: Credentials,
): AsyncResult<Connection, TemporalClientUnreachable> => {
  const unreachable = (cause: unknown): TemporalClientUnreachable =>
    new TemporalClientUnreachable({ address, cause });
  return fromThrowable(
    () => Connection.lazy({ address, ...connectionOptions(credentials) }),
    unreachable,
  )()
    .toAsync()
    .flatMap((connection) =>
      fromPromise(connection.ensureConnected(), unreachable)
        .map(() => connection)
        .flatMapErrCases((matcher) =>
          matcher.with(P.tag("TemporalClientUnreachable"), (initialization) =>
            fromPromise(connection.close(), (cleanup, defect) =>
              defect(
                new AggregateError(
                  [initialization.cause, cleanup],
                  "Temporal connection initialization and cleanup failed",
                  { cause: initialization.cause },
                ),
              ),
            ).flatMap(() => ErrAsync(initialization)),
          ),
        ),
    );
};
