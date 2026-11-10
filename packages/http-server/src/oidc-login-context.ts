import type { ConfigSchema } from "@btravstack/config";
import type { AnyPort, ServiceOf } from "@btravstack/di";
import type { buildAuthorizationUrl } from "openid-client";
import {
  TaggedError,
  fromSafePromise,
  fromThrowable,
  type AsyncResult,
  type Result,
} from "unthrown";

import { redirectUri as checkedRedirectUri } from "./oidc-logout-uri.js";
import type { Injected } from "./options.js";
import type { HttpRequestMetadata } from "./request-metadata.js";

/** Application policy refused the login context. No request details are retained. */
export class OidcLoginRefused extends TaggedError("OidcLoginRefused") {}

/** Validated application intent bound to one authorization transaction. */
export type OidcLoginContext<
  C,
  D extends Readonly<Record<string, AnyPort>> = Record<never, never>,
> = {
  /** Standard Schema validator applied to the same JSON input at login and callback. */
  readonly schema: ConfigSchema<unknown, C>;
  /** Resolve untrusted request metadata into JSON input, or refuse with undefined. */
  readonly resolve: (
    request: ServiceOf<HttpRequestMetadata>,
    services: Injected<D>,
  ) => Result<unknown, OidcLoginRefused> | AsyncResult<unknown, OidcLoginRefused>;
  /** Names authorizationParameters may add; protocol-owned names remain forbidden. */
  readonly allowedParameters?: readonly string[];
  /** Provider parameters derived only from validated context and injected policy. */
  readonly authorizationParameters?: (
    context: C,
    services: Injected<D>,
  ) => Parameters<typeof buildAuthorizationUrl>[1];
  /**
   * This context's absolute redirect URI, registered with the provider and naming
   * the mount's own `<prefix>/callback`. Derived only from the validated context
   * and injected policy, never request headers; it replaces the static `redirectUri`
   * and is derived again, so it must be the same for the same context.
   */
  readonly redirectUri?: (context: C, services: Injected<D>) => string;
  /** This context's absolute post-logout redirect URI, registered with the provider. Requires `tokens`. */
  readonly postLogoutRedirectUri?: (context: C, services: Injected<D>) => string;
};

/** The URIs one validated context derives; absent where the option is not set. */
type OidcContextUris = {
  readonly redirectUri: string | undefined;
  readonly postLogoutRedirectUri: string | undefined;
};

export const loginContextFor = <C, D extends Readonly<Record<string, AnyPort>>>(
  options: OidcLoginContext<C, D>,
  services: Injected<D>,
  callbackPath: string,
) => {
  const uris = (context: C): OidcContextUris | undefined => {
    const redirectUri =
      options.redirectUri === undefined
        ? undefined
        : checked(options.redirectUri(context, services), callbackPath);
    const postLogoutRedirectUri =
      options.postLogoutRedirectUri === undefined
        ? undefined
        : checked(options.postLogoutRedirectUri(context, services));
    return redirectUri === null || postLogoutRedirectUri === null
      ? undefined
      : { redirectUri, postLogoutRedirectUri };
  };
  return {
    prepare: (request: ServiceOf<HttpRequestMetadata>) =>
      fromSafePromise(
        (async () => {
          const input = (await options.resolve(request, services)).getOrUndefined();
          if (!jsonValue(input, 0)) return undefined;
          const serialized = JSON.stringify(input);
          if (Buffer.byteLength(serialized) > MAX_CONTEXT_BYTES) return undefined;
          const validated = await options.schema["~standard"].validate(
            parseJson(serialized).getOrUndefined(),
          );
          if (validated.issues !== undefined || validated.value === undefined) return undefined;
          const parameters = new URLSearchParams(
            options.authorizationParameters?.(validated.value, services),
          );
          const allowed = new Set(options.allowedParameters ?? []);
          const seen = new Set<string>();
          for (const [name] of parameters) {
            const normalized = name.toLowerCase();
            if (!allowed.has(name) || PROTECTED_PARAMETERS.has(normalized) || seen.has(normalized))
              return undefined;
            seen.add(normalized);
          }
          const derived = uris(validated.value);
          return derived === undefined ? undefined : { serialized, parameters, ...derived };
        })(),
      ),
    read: (serialized: string | undefined) =>
      fromSafePromise(
        (async () => {
          if (serialized === undefined || Buffer.byteLength(serialized) > MAX_CONTEXT_BYTES)
            return undefined;
          const input = parseJson(serialized).getOrUndefined();
          if (!jsonValue(input, 0)) return undefined;
          const validated = await options.schema["~standard"].validate(input);
          if (validated.issues !== undefined || validated.value === undefined) return undefined;
          const derived = uris(validated.value);
          return derived === undefined ? undefined : { context: validated.value, ...derived };
        })(),
      ),
  };
};

/**
 * The derived URI as a URL serializes it, which is what the code exchange sends;
 * `null` when it breaks the shared rule or names another path than the callback.
 */
const checked = (value: string, path?: string): string | null => {
  const valid = checkedRedirectUri(value).getOrUndefined();
  const url = valid === undefined ? null : URL.parse(valid);
  return url !== null && (path === undefined || url.pathname === path) ? url.href : null;
};

const MAX_CONTEXT_BYTES = 1024;
const MAX_DEPTH = 16;
const PROTECTED_PARAMETERS = new Set([
  "client_id",
  "client_secret",
  "redirect_uri",
  "response_type",
  "response_mode",
  "scope",
  "state",
  "nonce",
  "code_challenge",
  "code_challenge_method",
  "code_verifier",
  "request",
  "request_uri",
]);
const parseJson = fromThrowable(
  (input: string): unknown => JSON.parse(input),
  () => new OidcLoginRefused(),
);

const jsonValue = (value: unknown, depth: number): boolean => {
  if (depth > MAX_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= MAX_CONTEXT_BYTES;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    Array.isArray(value)
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  )
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length > MAX_CONTEXT_BYTES) return false;
  if (
    Array.isArray(value) &&
    (Object.keys(value).length !== value.length ||
      Object.keys(value).some((key, index) => key !== String(index)))
  )
    return false;
  return Reflect.ownKeys(descriptors).every((key) => {
    if (Array.isArray(value) && key === "length") return true;
    if (typeof key !== "string") return false;
    const descriptor = descriptors[key];
    return (
      descriptor !== undefined &&
      descriptor.enumerable === true &&
      Object.hasOwn(descriptor, "value") &&
      jsonValue(descriptor.value, depth + 1)
    );
  });
};
