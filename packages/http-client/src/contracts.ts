import { Port } from "@btravstack/di";
import { TaggedError, type AsyncResult } from "unthrown";

/** PEM client identity supplied by the application's secret store. */
export type HttpTlsIdentity = {
  readonly cert: string;
  readonly key: string;
  readonly passphrase?: string;
};
/** An identity bound to one approved origin. The trusted source is read for every connection. */
export type HttpTlsBinding = {
  readonly origin: string;
  /** Read an atomic credential snapshot from an application-owned secret cache; may throw on failure. */
  readonly credentials: () => HttpTlsIdentity;
};

/** Private network approval for one exact HTTPS origin. Only RFC 1918 and IPv6 unique-local CIDRs are accepted. */
export type HttpPrivateOrigin = {
  readonly origin: string;
  readonly cidrs: readonly string[];
};

/** Application-owned approvals. Tenant configuration must never supply or extend this policy. */
export type HttpPolicy = {
  /** Exact HTTPS origins, including non-default ports. Snapshotted when the client is built. */
  readonly origins: readonly string[];
  /** Exact-origin client identities. Sources are captured at construction; credentials may rotate. */
  readonly tlsIdentities?: readonly HttpTlsBinding[];
  /** Deployment-owned private CIDRs per approved origin; omitted origins remain public-only. */
  readonly privateOrigins?: readonly HttpPrivateOrigin[];
  /** Maximum complete response body bytes. Only identity encoding is supported. */
  readonly maxResponseBytes: number;
  /** Whole-operation budget in milliseconds, including DNS, TLS, headers and body. */
  readonly deadlineMs: number;
};
/** Invalid application policy; contains no input URLs. */
export class HttpPolicyInvalid extends TaggedError("HttpPolicyInvalid")<{
  readonly field:
    | "origins"
    | "maxResponseBytes"
    | "deadlineMs"
    | "tlsIdentities"
    | "privateOrigins";
}> {}
/** The request was refused before transmission. */
export class HttpPolicyRejected extends TaggedError("HttpPolicyRejected")<{
  readonly reason: "url" | "scheme" | "credentials" | "origin" | "headers" | "request";
}> {}
/** At least one resolved address, or a literal address, was private or reserved without approval. */
export class HttpDestinationForbidden extends TaggedError("HttpDestinationForbidden") {}
/** A redirect response is never followed. Location is deliberately omitted. */
export class HttpRedirectRefused extends TaggedError("HttpRedirectRefused")<{
  readonly status: number;
}> {}
/** The remote server ignored the identity-only encoding requirement. */
export class HttpEncodingRefused extends TaggedError("HttpEncodingRefused") {}
/** Streaming bytes exceeded the application limit. */
export class HttpResponseTooLarge extends TaggedError("HttpResponseTooLarge")<{
  readonly limit: number;
}> {}
/** The whole-operation deadline expired and the connection was destroyed. */
export class HttpDeadlineExceeded extends TaggedError("HttpDeadlineExceeded") {}
/** The caller cancelled and the connection was destroyed. */
export class HttpCancelled extends TaggedError("HttpCancelled") {}
/** DNS, TLS, connection or response framing failed. No raw cause or URL is retained. */
export class HttpUnavailable extends TaggedError("HttpUnavailable") {}
/** All modeled failures of an outbound request. */
export type HttpFailure =
  | HttpPolicyRejected
  | HttpDestinationForbidden
  | HttpRedirectRefused
  | HttpEncodingRefused
  | HttpResponseTooLarge
  | HttpDeadlineExceeded
  | HttpCancelled
  | HttpUnavailable;
/** Deliberately narrow request; no agent, proxy, resolver, TLS or redirect overrides. */
export type HttpRequest = {
  readonly url: string | URL;
  readonly method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  readonly signal?: AbortSignal;
};
export const supportedMethod = (method: unknown): method is NonNullable<HttpRequest["method"]> =>
  typeof method === "string" &&
  ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method);

/** A complete body within the policy limit; HTTP error statuses remain ordinary responses. */
export type HttpResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
};
/** The outbound capability an application injects. */
export type HttpClientService = {
  readonly request: (request: HttpRequest) => AsyncResult<HttpResponse, HttpFailure>;
};
/** One policy-bound outbound client per application graph. */
export class HttpClient extends Port("HttpClient")<HttpClientService> {}
