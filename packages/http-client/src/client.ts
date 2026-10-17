import dns from "node:dns";
import { validateHeaderName, validateHeaderValue } from "node:http";
import https from "node:https";
import { isIP } from "node:net";

import { Err, ErrAsync, Ok, fromSafePromise, fromThrowable, type Result } from "unthrown";

import { publicAddress } from "./address.js";
import {
  HttpCancelled,
  HttpDeadlineExceeded,
  HttpDestinationForbidden,
  HttpEncodingRefused,
  HttpPolicyInvalid,
  HttpPolicyRejected,
  HttpRedirectRefused,
  HttpResponseTooLarge,
  HttpUnavailable,
  supportedMethod,
  type HttpClientService,
  type HttpFailure,
  type HttpPolicy,
  type HttpRequest,
  type HttpResponse,
} from "./contracts.js";

const parseUrl = fromThrowable(
  (input: string | URL) => new URL(input),
  () => new HttpPolicyRejected({ reason: "url" }),
);
const validateHeaders = fromThrowable(
  (headers: Readonly<Record<string, string>>) => {
    for (const [name, value] of Object.entries(headers)) {
      validateHeaderName(name);
      validateHeaderValue(name, value);
    }
  },
  () => new HttpPolicyRejected({ reason: "headers" }),
);
const hostname = (url: URL) => url.hostname.replace(/^\[|\]$/g, "");
const destination = (url: URL): HttpFailure | undefined => {
  if (url.protocol !== "https:") return new HttpPolicyRejected({ reason: "scheme" });
  if (url.username !== "" || url.password !== "")
    return new HttpPolicyRejected({ reason: "credentials" });
  if (isIP(hostname(url)) !== 0 && !publicAddress(hostname(url)))
    return new HttpDestinationForbidden();
  return undefined;
};

const exchange = (url: URL, input: HttpRequest, policy: HttpPolicy) =>
  fromSafePromise(
    new Promise<Result<HttpResponse, HttpFailure>>((resolve) => {
      let finished = false;
      let request: ReturnType<typeof https.request> | undefined;
      const finish = (result: Result<HttpResponse, HttpFailure>) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", cancelled);
        resolve(result);
        request?.destroy();
      };
      const cancelled = () => finish(Err(new HttpCancelled()));
      const timer = setTimeout(() => finish(Err(new HttpDeadlineExceeded())), policy.deadlineMs);
      input.signal?.addEventListener("abort", cancelled, { once: true });
      if (input.signal?.aborted) {
        cancelled();
        return;
      }
      const options: https.RequestOptions & { autoSelectFamily: false } = {
        method: input.method ?? "GET",
        headers: { ...input.headers, "accept-encoding": "identity" },
        agent: false,
        autoSelectFamily: false,
        rejectUnauthorized: true,
        lookup: (host, _options, callback) => {
          dns.lookup(host, { all: true, verbatim: true }, (error, addresses) => {
            if (finished) return;
            if (error !== null || addresses.length === 0) {
              callback(error ?? new HttpUnavailable(), "", 4);
              return;
            }
            if (addresses.some(({ address }) => !publicAddress(address))) {
              finish(Err(new HttpDestinationForbidden()));
              callback(new HttpDestinationForbidden(), "", 4);
              return;
            }
            const first = addresses[0]!;
            callback(null, first.address, first.family);
          });
        },
      };
      request = https.request(url, options, (response) => {
        response.on("error", () => finish(Err(new HttpUnavailable())));
        const status = response.statusCode!;
        if (status >= 300 && status < 400 && status !== 304) {
          finish(Err(new HttpRedirectRefused({ status })));
          return;
        }
        const encoding = response.headers["content-encoding"];
        if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") {
          finish(Err(new HttpEncodingRefused()));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > policy.maxResponseBytes) {
            finish(Err(new HttpResponseTooLarge({ limit: policy.maxResponseBytes })));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          finish(
            Ok({
              status,
              headers: Object.fromEntries(
                Object.entries(response.headers)
                  .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
                  .map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value]),
              ),
              body: Buffer.concat(chunks, size),
            }),
          ),
        );
      });
      request.on("error", () => finish(Err(new HttpUnavailable())));
      request.end(input.body);
    }),
  ).flatMap((result) => result);

export const snapshotRequest = (request: HttpRequest) => ({
  ...request,
  url: request.url instanceof URL ? new URL(request.url) : request.url,
  headers: { ...request.headers },
  ...(request.body instanceof Uint8Array ? { body: new Uint8Array(request.body) } : {}),
});

/** Build once at the application boundary. Origins and limits are copied, never read from the caller again. */
export const createHttpClient = (
  input: HttpPolicy,
): Result<HttpClientService, HttpPolicyInvalid> => {
  for (const field of ["maxResponseBytes", "deadlineMs"] as const) {
    if (!Number.isSafeInteger(input[field]) || input[field] < 1 || input[field] > 2_147_483_647)
      return Err(new HttpPolicyInvalid({ field }));
  }
  const origins = new Set<string>();
  for (const origin of input.origins) {
    const parsed = parseUrl(origin).getOrUndefined();
    if (
      parsed === undefined ||
      destination(parsed) !== undefined ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    )
      return Err(new HttpPolicyInvalid({ field: "origins" }));
    origins.add(parsed.origin);
  }
  if (origins.size === 0) return Err(new HttpPolicyInvalid({ field: "origins" }));
  const policy = {
    origins: [...origins],
    maxResponseBytes: input.maxResponseBytes,
    deadlineMs: input.deadlineMs,
  };
  return Ok({
    request: (request) => {
      const input = snapshotRequest(request);
      if (input.method !== undefined && !supportedMethod(input.method))
        return ErrAsync(new HttpPolicyRejected({ reason: "request" }));
      return parseUrl(input.url)
        .toAsync()
        .flatMap((url) => {
          const refused = destination(url);
          if (refused !== undefined) return ErrAsync(refused);
          if (!origins.has(url.origin))
            return ErrAsync(new HttpPolicyRejected({ reason: "origin" }));
          if (
            Object.keys(input.headers ?? {}).some((key) =>
              [
                "host",
                "connection",
                "transfer-encoding",
                "content-length",
                "trailer",
                "te",
                "upgrade",
              ].includes(key.toLowerCase()),
            )
          )
            return ErrAsync(new HttpPolicyRejected({ reason: "headers" }));
          return validateHeaders(input.headers)
            .toAsync()
            .flatMap(() => exchange(url, input, policy));
        });
    },
  });
};
