import { readFile, realpath } from "node:fs/promises";

import { Config, ConfigInvalid, type ConfigField, type ConfigIssue } from "@btravstack/config";
import type { TLSConfig } from "@temporalio/client";
import {
  Err,
  ErrAsync,
  Ok,
  OkAsync,
  allAsync,
  TaggedError,
  fromPromise,
  validateAllAsync,
  type AsyncResult,
  type FailureView,
  type Result,
} from "unthrown";

/**
 * How a connection to Temporal is secured: what {@link temporalSecurity} binds
 * from the environment. Every field may be absent, which is today's plaintext
 * connection with no key.
 */
export type TemporalConnectionSecurity = {
  /**
   * `TEMPORAL_TLS`: TLS on or off. Unset, it is on exactly when an API key is
   * set, as Temporal's own clients do. The server and client certificate
   * fields require it on.
   */
  readonly tls?: boolean | undefined;
  /** `TEMPORAL_TLS_SERVER_CA_CERT_PATH`: the PEM bundle the server's certificate is verified against, instead of the system's roots. */
  readonly serverCaCertPath?: string | undefined;
  /** `TEMPORAL_TLS_SERVER_NAME`: the name the server's certificate is verified for, and sent as SNI. */
  readonly serverName?: string | undefined;
  /** `TEMPORAL_TLS_CLIENT_CERT_PATH`: the client certificate presented for mTLS, with its key. */
  readonly clientCertPath?: string | undefined;
  /** `TEMPORAL_TLS_CLIENT_KEY_PATH`: the client certificate's private key. */
  readonly clientKeyPath?: string | undefined;
  /** `TEMPORAL_API_KEY`: an API key sent as `Authorization: Bearer`. */
  readonly apiKey?: string | undefined;
  /** `TEMPORAL_API_KEY_PATH`: a file holding the API key, read again as it rotates. */
  readonly apiKeyPath?: string | undefined;
  /** `TEMPORAL_CREDENTIALS_RELOAD_MS` (default `60000`): how often the files above and a composed credential source are read again. */
  readonly credentialsReloadMs?: number;
};

/** An application-owned source of renewable bearer credentials; it owns caching and expiry. */
export type TemporalApiKeySource = {
  readonly read: () => AsyncResult<string, TemporalApiKeyUnavailable>;
};

/** A renewable credential could not be obtained; its value is never diagnostic data. */
export class TemporalApiKeyUnavailable extends TaggedError("TemporalApiKeyUnavailable") {
  override message = "the Temporal API key is unavailable";
}

const VARIABLES = {
  tls: "TEMPORAL_TLS",
  serverCaCertPath: "TEMPORAL_TLS_SERVER_CA_CERT_PATH",
  serverName: "TEMPORAL_TLS_SERVER_NAME",
  clientCertPath: "TEMPORAL_TLS_CLIENT_CERT_PATH",
  clientKeyPath: "TEMPORAL_TLS_CLIENT_KEY_PATH",
  apiKey: "TEMPORAL_API_KEY",
  apiKeyPath: "TEMPORAL_API_KEY_PATH",
  credentialsReloadMs: "TEMPORAL_CREDENTIALS_RELOAD_MS",
} as const;

const DEFAULT_RELOAD_MS = 60_000;

const FILE_KEYS = ["serverCaCertPath", "clientCertPath", "clientKeyPath", "apiKeyPath"] as const;

type FilePaths = Readonly<
  Record<(typeof FILE_KEYS)[number], Result<string | undefined, ConfigIssue>>
>;

type CredentialFiles = readonly [
  Buffer | undefined,
  Buffer | undefined,
  Buffer | undefined,
  string | undefined,
];

class CredentialFilesChanged extends TaggedError("CredentialFilesChanged")<{
  readonly variables: readonly string[];
}> {
  override message = "the Temporal credential files changed while being read";
}

class CredentialPathUnavailable extends TaggedError("CredentialPathUnavailable")<{
  readonly issue: ConfigIssue;
}> {
  override message = "the Temporal credential path cannot be resolved";
}

const optional = <T, const V extends string>(
  field: ConfigField<T, V>,
): ConfigField<T | undefined, V, "optional"> => ({
  variable: field.variable,
  parse: (raw) => (raw === undefined ? Ok(undefined) : field.parse(raw)),
});

/**
 * The `Config` fields of {@link TemporalConnectionSecurity}, Temporal's own
 * variable names: spread them into the `Config.object` that binds a client's
 * settings beside `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE`.
 */
export const temporalSecurity = {
  tls: optional(Config.boolean(VARIABLES.tls)),
  serverCaCertPath: optional(Config.string(VARIABLES.serverCaCertPath)),
  serverName: optional(Config.string(VARIABLES.serverName)),
  clientCertPath: optional(Config.string(VARIABLES.clientCertPath)),
  clientKeyPath: optional(Config.string(VARIABLES.clientKeyPath)),
  apiKey: optional(Config.string(VARIABLES.apiKey)),
  apiKeyPath: optional(Config.string(VARIABLES.apiKeyPath)),
  credentialsReloadMs: Config.integer(VARIABLES.credentialsReloadMs, {
    default: DEFAULT_RELOAD_MS,
    min: 1,
    // setTimeout's ceiling: Node runs a longer delay after 1 ms.
    max: 2_147_483_647,
  }),
};

/** What a connection is opened with: the TLS configuration and API key, read from their files. */
export type Credentials = {
  readonly tls: TLSConfig | undefined;
  readonly apiKey: string | undefined;
};

/**
 * The credentials `security` describes, read from their files — or every
 * combination it cannot connect with, and every file it cannot read, as one
 * `ConfigInvalid` against `port`.
 */
export function credentialsOf(
  port: string,
  security: TemporalConnectionSecurity,
): AsyncResult<Credentials, ConfigInvalid>;
export function credentialsOf(
  port: string,
  security: TemporalConnectionSecurity,
  source: TemporalApiKeySource | undefined,
): AsyncResult<Credentials, ConfigInvalid | TemporalApiKeyUnavailable>;
export function credentialsOf(
  port: string,
  security: TemporalConnectionSecurity,
  source?: TemporalApiKeySource,
): AsyncResult<Credentials, ConfigInvalid | TemporalApiKeyUnavailable> {
  const issues = refusals(security, source);
  if (issues.length > 0) return ErrAsync(new ConfigInvalid({ port, issues }));
  return filesOf(port, security).flatMap(([ca, crt, key, apiKeyFile]) => {
    const credentials: Credentials = {
      tls: tlsOn(security, source)
        ? {
            ...(ca === undefined ? {} : { serverRootCACertificate: ca }),
            ...(security.serverName === undefined
              ? {}
              : { serverNameOverride: security.serverName }),
            ...(crt === undefined || key === undefined ? {} : { clientCertPair: { crt, key } }),
          }
        : undefined,
      apiKey: security.apiKey ?? apiKeyFile,
    };
    return source === undefined
      ? OkAsync(credentials)
      : source
          .read()
          .flatMap((apiKey) =>
            apiKey.trim() === ""
              ? Err(new TemporalApiKeyUnavailable())
              : Ok({ ...credentials, apiKey }),
          );
  });
}

/** The connection options `credentials` adds to an address: nothing, for a plaintext connection with no key. */
export const connectionOptions = (
  credentials: Credentials,
): { readonly tls?: TLSConfig; readonly apiKey?: string } => ({
  ...(credentials.tls === undefined ? {} : { tls: credentials.tls }),
  ...(credentials.apiKey === undefined ? {} : { apiKey: credentials.apiKey }),
});

/** Whether files or an application credential source can change while the connection is open. */
export const rotates = (
  security: TemporalConnectionSecurity,
  source?: TemporalApiKeySource,
): boolean =>
  source !== undefined ||
  [
    security.serverCaCertPath,
    security.clientCertPath,
    security.clientKeyPath,
    security.apiKeyPath,
  ].some((path) => path !== undefined);

/** What changed between two readings: the TLS files, the API key alone, or nothing. */
export type CredentialsChange = "tls" | { readonly apiKey: string } | undefined;

const changeOf = (previous: Credentials, next: Credentials): CredentialsChange => {
  if (JSON.stringify(previous.tls) !== JSON.stringify(next.tls)) return "tls";
  return next.apiKey === undefined || next.apiKey === previous.apiKey
    ? undefined
    : { apiKey: next.apiKey };
};

/**
 * Reads `security`'s files every `credentialsReloadMs` and hands `apply` each
 * reading that changed; a reading that failed, or that `apply` refused, leaves
 * the previous one current and is tried again on the next tick. A file that
 * cannot be read is also handed to `unreadable`. With an application source,
 * `unavailable` handles a failed read or apply; recovery rebuilds the connection.
 * Answers the stop, which
 * settles once a reload in flight has: a reload never applies after it.
 */
export const reloading = <E>(
  port: string,
  security: TemporalConnectionSecurity,
  initial: Credentials,
  apply: (next: Credentials, change: Exclude<CredentialsChange, undefined>) => AsyncResult<void, E>,
  unreadable?: (
    failure: FailureView<ConfigInvalid | TemporalApiKeyUnavailable, Credentials>,
  ) => void,
  source?: TemporalApiKeySource,
  unavailable?: () => AsyncResult<void, never>,
): (() => PromiseLike<unknown>) => {
  let current = initial;
  let stopped = false;
  let retry = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: PromiseLike<unknown> = OkAsync();
  const schedule = (): void => {
    timer = setTimeout(() => {
      const read = credentialsOf(port, security, source);
      const applying = (unreadable === undefined ? read : read.tapFailure(unreadable)).flatMap(
        (next) => {
          const change = retry ? "tls" : changeOf(current, next);
          return change === undefined || stopped
            ? OkAsync()
            : apply(next, change).map(() => {
                current = next;
                retry = false;
              });
        },
      );
      inFlight = applying.then((result) => {
        if (result.isOk() || source === undefined || stopped) {
          again();
          return OkAsync();
        }
        retry = true;
        return unavailable === undefined
          ? OkAsync().tap(again)
          : unavailable().tap(again).tapFailure(again);
      });
    }, security.credentialsReloadMs ?? DEFAULT_RELOAD_MS);
    timer.unref();
  };
  // A tick in flight when the reloading stops settles after it, and must not schedule another.
  const again = (): void => {
    if (!stopped) schedule();
  };
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    return inFlight;
  };
};

const tlsOn = (security: TemporalConnectionSecurity, source?: TemporalApiKeySource): boolean =>
  security.tls ??
  (source !== undefined || security.apiKey !== undefined || security.apiKeyPath !== undefined);

const refusals = (
  security: TemporalConnectionSecurity,
  source?: TemporalApiKeySource,
): ConfigIssue[] => {
  const issues: ConfigIssue[] = [];
  const set = (key: keyof typeof VARIABLES): boolean => security[key] !== undefined;
  const refuse = (key: keyof typeof VARIABLES, message: string): void => {
    issues.push({ message, path: [VARIABLES[key]] });
  };
  if (!tlsOn(security, source))
    for (const key of [
      "serverCaCertPath",
      "serverName",
      "clientCertPath",
      "clientKeyPath",
      "apiKey",
      "apiKeyPath",
    ] as const)
      if (set(key)) refuse(key, `requires ${VARIABLES.tls}=true`);
  if (source !== undefined) {
    if (security.tls === false) refuse("tls", "must be true when an API key source is composed");
    for (const key of ["apiKey", "apiKeyPath", "clientCertPath", "clientKeyPath"] as const)
      if (set(key)) refuse(key, "cannot be combined with an API key source");
  }
  if (set("clientCertPath") && !set("clientKeyPath"))
    refuse("clientKeyPath", `is required with ${VARIABLES.clientCertPath}`);
  if (set("clientKeyPath") && !set("clientCertPath"))
    refuse("clientCertPath", `is required with ${VARIABLES.clientKeyPath}`);
  if (set("apiKey") && set("apiKeyPath"))
    refuse("apiKeyPath", `cannot be combined with ${VARIABLES.apiKey}`);
  if ((set("apiKey") || set("apiKeyPath")) && (set("clientCertPath") || set("clientKeyPath")))
    refuse(set("apiKey") ? "apiKey" : "apiKeyPath", "cannot be combined with a client certificate");
  return issues;
};

const filesOf = (
  port: string,
  security: TemporalConnectionSecurity,
  attempts = 3,
): AsyncResult<CredentialFiles, ConfigInvalid> =>
  pathsOf(security)
    .flatMap((paths) =>
      validateAllAsync(
        [
          fileOf("serverCaCertPath", paths),
          fileOf("clientCertPath", paths),
          fileOf("clientKeyPath", paths),
          fileOf("apiKeyPath", paths),
        ],
        (failed) => new ConfigInvalid({ port, issues: failed }),
      )
        .flatTap(() => unchangedPaths(security, paths))
        .flatMapErrCases((matcher) =>
          matcher
            .with({ _tag: "ConfigInvalid" }, (failure) =>
              unchangedPaths(security, paths).flatMap(() => Err(failure)),
            )
            .with({ _tag: "CredentialFilesChanged" }, Err),
        ),
    )
    .flatMapErrCases((matcher) =>
      matcher
        .with({ _tag: "ConfigInvalid" }, Err)
        .with({ _tag: "CredentialFilesChanged" }, (failure) =>
          attempts > 1
            ? filesOf(port, security, attempts - 1)
            : Err(
                new ConfigInvalid({
                  port,
                  issues: failure.variables.map((variable) => ({
                    message: "changed while being read",
                    path: [variable],
                  })),
                }),
              ),
        ),
    );

const pathsOf = (security: TemporalConnectionSecurity): AsyncResult<FilePaths, never> =>
  allAsync([
    pathOf("serverCaCertPath", security),
    pathOf("clientCertPath", security),
    pathOf("clientKeyPath", security),
    pathOf("apiKeyPath", security),
  ]).map(([serverCaCertPath, clientCertPath, clientKeyPath, apiKeyPath]) => ({
    serverCaCertPath,
    clientCertPath,
    clientKeyPath,
    apiKeyPath,
  }));

const pathOf = (
  key: (typeof FILE_KEYS)[number],
  security: TemporalConnectionSecurity,
): AsyncResult<Result<string | undefined, ConfigIssue>, never> =>
  resolvePath(key, security)
    .map((path) => Ok(path))
    .recoverErrCases((matcher) =>
      matcher.with({ _tag: "CredentialPathUnavailable" }, ({ issue }) => Err(issue)),
    );

const resolvePath = (
  key: (typeof FILE_KEYS)[number],
  security: TemporalConnectionSecurity,
  attempts = 3,
): AsyncResult<string | undefined, CredentialPathUnavailable> => {
  const path = security[key];
  if (path === undefined) return OkAsync(undefined);
  return fromPromise(
    realpath(path),
    (cause) =>
      new CredentialPathUnavailable({
        issue: {
          message: `cannot be read (${(cause as NodeJS.ErrnoException).code})`,
          path: [VARIABLES[key]],
        },
      }),
  ).flatMapErrCases((matcher) =>
    matcher.with({ _tag: "CredentialPathUnavailable" }, (failure) =>
      attempts > 1 ? resolvePath(key, security, attempts - 1) : Err(failure),
    ),
  );
};

const unchangedPaths = (
  security: TemporalConnectionSecurity,
  before: FilePaths,
): AsyncResult<void, CredentialFilesChanged> =>
  pathsOf(security)
    .ensure(
      (after) => FILE_KEYS.every((key) => pathIdentity(before[key]) === pathIdentity(after[key])),
      (after) =>
        new CredentialFilesChanged({
          variables: FILE_KEYS.filter(
            (key) => pathIdentity(before[key]) !== pathIdentity(after[key]),
          ).map((key) => VARIABLES[key]),
        }),
    )
    .discard();

const pathIdentity = (path: Result<string | undefined, ConfigIssue>): string | undefined =>
  JSON.stringify(path.getOrElse((issue) => issue));

function fileOf(
  key: "serverCaCertPath" | "clientCertPath" | "clientKeyPath",
  paths: FilePaths,
): AsyncResult<Buffer | undefined, ConfigIssue>;
function fileOf(key: "apiKeyPath", paths: FilePaths): AsyncResult<string | undefined, ConfigIssue>;
function fileOf(
  key: (typeof FILE_KEYS)[number],
  paths: FilePaths,
): AsyncResult<Buffer | string | undefined, ConfigIssue> {
  return paths[key].toAsync().flatMap((path) => {
    if (path === undefined) return OkAsync(undefined);
    const issue = (message: string): ConfigIssue => ({ message, path: [VARIABLES[key]] });
    return fromPromise(readFile(path), (cause) =>
      issue(`cannot be read (${(cause as NodeJS.ErrnoException).code})`),
    ).flatMap((bytes) => {
      const content = key === "apiKeyPath" ? bytes.toString("utf8").trim() : bytes;
      // A file being rewritten in place reads empty for a moment; it is not a credential.
      return content.length === 0 ? Err(issue("is empty")) : Ok(content);
    });
  });
}
