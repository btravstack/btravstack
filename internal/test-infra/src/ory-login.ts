import { ORY_REDIRECT_URI, type OryUser } from "./ory-provision.js";

/** Kratos's public API, on the fixed host port `sharedOry` publishes it on. */
const KRATOS_PUBLIC = "http://localhost:4433/";

/**
 * Enough for the five redirects the flow has, and short enough that a loop
 * Hydra or Kratos never leaves is reported rather than waited on.
 */
const MAX_HOPS = 10;

const fail: (message: string) => never = (message) => {
  // oxlint-disable-next-line unthrown/no-throw -- a vitest fixture reports failure by rejecting; there is no Result channel here
  throw new Error(message);
};

/**
 * A browser's cookie store, keyed by host: Kratos, Hydra and the consent
 * handler each set their own, and none of them reads another's.
 *
 * Module-scoped and cleared by every {@link headlessLogin}, because a browser
 * has one of these — which is what lets a logout walk carry the session the
 * login left, and what stops a second login being silently skipped by the
 * first one's Kratos session.
 */
const jar = new Map<string, Map<string, string>>();

const cookiesFor = (url: URL): Map<string, string> => {
  const held = jar.get(url.host);
  if (held !== undefined) return held;

  const fresh = new Map<string, string>();
  jar.set(url.host, fresh);
  return fresh;
};

type Init = {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
};

const go = async (url: URL, init?: Init): Promise<Response> => {
  const held = cookiesFor(url);
  const cookie = [...held].map(([name, value]) => `${name}=${value}`).join("; ");
  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    headers: { ...(cookie === "" ? {} : { cookie }), ...init?.headers },
  });

  for (const set of response.headers.getSetCookie()) {
    const pair = set.split(";")[0] ?? "";
    const at = pair.indexOf("=");
    const value = pair.slice(at + 1);
    if (value === "") held.delete(pair.slice(0, at).trim());
    else held.set(pair.slice(0, at).trim(), value);
  }

  return response;
};

const redirect = async (from: URL, init?: Init): Promise<URL> => {
  const response = await go(from, init);
  const location = response.headers.get("location");
  if (location === null)
    return fail(
      `${from.origin}${from.pathname} answered ${response.status} rather than a redirect: ${await response.text()}`,
    );

  return new URL(location, from);
};

/**
 * The two hops that read a body rather than a `Location`, held to the same
 * standard: an unexpected status names itself and the body, where an unguarded
 * `json()` would reject with a bare `SyntaxError` naming neither.
 *
 * The expected status is the caller's because Kratos's is not always 200 — a
 * browser flow submitted as JSON answers **422**, which is how it says where to
 * go next rather than that anything went wrong.
 */
const readJson = async <T>(from: URL, expected: number, init?: Init): Promise<T> => {
  const response = await go(from, init);
  if (response.status !== expected)
    return fail(
      `${from.origin}${from.pathname} answered ${response.status} rather than ${expected}: ${await response.text()}`,
    );

  return response.json() as Promise<T>;
};

/**
 * Follow redirects from `from` until one lands on `until`, which is answered
 * rather than fetched — nothing serves either the callback or the post-logout
 * URI, and a test asserts on the URL the provider chose.
 */
export const followRedirects = async (from: URL, until: string): Promise<URL> => {
  let at = from;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const next = await redirect(at);
    if (next.href.startsWith(until)) return next;
    at = next;
  }

  return fail(`${from.href} did not reach ${until} within ${MAX_HOPS} redirects`);
};

type LoginFlow = {
  readonly ui: {
    readonly action: string;
    readonly nodes: readonly {
      readonly attributes: { readonly name?: string; readonly value?: string };
    }[];
  };
};

/** Kratos's answer to a browser flow submitted with `Accept: application/json`: a 422 carrying where to go next. */
type Submitted = { readonly redirect_browser_to?: string };

/**
 * The flow the spike measured, through Kratos's own self-service login API and
 * Hydra's redirects, with a cookie jar and no browser.
 *
 * Answers the callback URL Hydra redirected to, carrying `code` and `state`;
 * it never contacts the redirect URI, which nothing serves.
 */
export const headlessLogin = async (options: {
  readonly authorizationUrl: URL;
  readonly user: OryUser;
}): Promise<URL> => {
  jar.clear();

  const login = await redirect(options.authorizationUrl);
  const ui = await redirect(login);
  const flowId = ui.searchParams.get("flow") ?? fail(`Kratos did not answer a login flow: ${ui}`);

  const flow = await readJson<LoginFlow>(
    new URL(`self-service/login/flows?id=${encodeURIComponent(flowId)}`, KRATOS_PUBLIC),
    200,
    { headers: { accept: "application/json" } },
  );
  const csrf =
    flow.ui.nodes.find((node) => node.attributes.name === "csrf_token")?.attributes.value ??
    fail(`Kratos flow ${flowId} carries no csrf_token node`);

  const submitted = await readJson<Submitted>(new URL(flow.ui.action), 422, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      method: "password",
      identifier: options.user.email,
      password: options.user.password,
      csrf_token: csrf,
    }),
  });

  const verifier =
    submitted.redirect_browser_to ??
    fail(`Kratos did not sign ${options.user.email} in: ${JSON.stringify(submitted)}`);

  return followRedirects(new URL(verifier), ORY_REDIRECT_URI);
};
