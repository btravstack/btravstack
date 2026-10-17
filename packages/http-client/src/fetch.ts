import { HttpPolicyRejected, supportedMethod, type HttpClientService } from "./contracts.js";

/**
 * Adapt this boundary to the platform fetch protocol (including openid-client's customFetch).
 * Unsupported Request objects, streaming bodies and fetch transport overrides are refused.
 * This is the edge where Result failures reject for the upstream fetch consumer.
 */
export const httpClientFetch =
  (client: HttpClientService): typeof fetch =>
  async (input, init) => {
    const unsupported = () => {
      // oxlint-disable-next-line unthrown/no-throw -- Fetch consumers require rejected promises at this boundary.
      throw new HttpPolicyRejected({ reason: "request" });
    };
    if (!(typeof input === "string" || input instanceof URL)) return unsupported();
    if (
      init !== undefined &&
      Object.keys(init).some(
        (key) => !["method", "headers", "body", "signal", "redirect"].includes(key),
      )
    )
      return unsupported();
    const method = init?.method?.toUpperCase() ?? "GET";
    if (!supportedMethod(method)) return unsupported();
    const body = init?.body;
    if (
      body !== undefined &&
      body !== null &&
      typeof body !== "string" &&
      !(body instanceof URLSearchParams) &&
      !(body instanceof Uint8Array)
    )
      return unsupported();
    const headers = new Headers(init?.headers);
    if (!headers.has("content-type")) {
      if (body instanceof URLSearchParams)
        headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
      else if (typeof body === "string") headers.set("content-type", "text/plain;charset=UTF-8");
    }
    const response = await client.request({
      url: input,
      method,
      headers: Object.fromEntries(headers),
      ...(body === undefined || body === null
        ? {}
        : { body: body instanceof URLSearchParams ? body.toString() : body }),
      ...(init?.signal == null ? {} : { signal: init.signal }),
    });
    return response.match({
      ok: ({ status, headers, body }) =>
        new Response(
          method === "HEAD" || [204, 205, 304].includes(status) ? null : new Uint8Array(body),
          { status, headers },
        ),
      errCases: (matcher) =>
        matcher.with(
          { _tag: "HttpPolicyRejected" },
          { _tag: "HttpDestinationForbidden" },
          { _tag: "HttpRedirectRefused" },
          { _tag: "HttpEncodingRefused" },
          { _tag: "HttpResponseTooLarge" },
          { _tag: "HttpDeadlineExceeded" },
          { _tag: "HttpCancelled" },
          { _tag: "HttpUnavailable" },
          (error) => {
            // oxlint-disable-next-line unthrown/no-throw -- Fetch consumers require rejected promises at this boundary.
            throw error;
          },
        ),
      defect: (cause) => {
        // oxlint-disable-next-line unthrown/no-throw -- Preserve defects across the native fetch boundary.
        throw cause;
      },
    });
  };
