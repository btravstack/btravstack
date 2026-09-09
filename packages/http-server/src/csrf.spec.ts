import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("csrf", () => {
  it("serves a same-origin state change carrying the session cookie", async ({ csrf }) => {
    // GIVEN a deployment whose one scheme reads a cookie, so the check is on
    const calls = await csrf.cookies();
    // WHEN the browser posts from the page it is already on
    const answered = await calls.post({
      cookie: calls.cookie,
      "sec-fetch-site": "same-origin",
    });
    // THEN the fragment answers
    expect(answered).toEqual({ status: 200, text: "<p>saved</p>" });
  });

  it("refuses a cross-site state change carrying the session cookie", async ({ csrf }) => {
    // GIVEN the same deployment
    const calls = await csrf.cookies();
    // WHEN another site posts with the browser's ambient cookie
    const answered = await calls.post({
      cookie: calls.cookie,
      "sec-fetch-site": "cross-site",
    });
    // THEN it is refused before any answerer, with nothing said about why
    expect(answered).toEqual({ status: 403, text: "" });
  });

  it("serves a cross-site state change that carries no cookie", async ({ csrf }) => {
    // GIVEN the same deployment
    const calls = await csrf.cookies();
    // WHEN a caller with no ambient authority posts from anywhere
    const answered = await calls.post({ "sec-fetch-site": "cross-site" });
    // THEN it is served: a bearer caller is not a CSRF target
    expect(answered).toEqual({ status: 200, text: "<p>saved</p>" });
  });

  it("serves a cross-site read carrying the session cookie", async ({ csrf }) => {
    // GIVEN the same deployment
    const calls = await csrf.cookies();
    // WHEN the read arrives from another site with the cookie
    const answered = await calls.get({ cookie: calls.cookie, "sec-fetch-site": "cross-site" });
    // THEN it is served: the check is for state changes
    expect(answered).toEqual({ status: 200, text: "<p>u-1</p>" });
  });

  it("falls back to a matching Origin when fetch metadata is absent", async ({ csrf }) => {
    // GIVEN a deployment whose check is on, and a browser sending no metadata
    const calls = await csrf.cookies();
    // WHEN the Origin names the host the request was sent to
    const answered = await calls.post({ cookie: calls.cookie, origin: calls.origin });
    // THEN it is served — the host it names is the one answering
    expect(answered).toEqual({ status: 200, text: "<p>saved</p>" });
  });

  it("refuses a mismatching Origin when fetch metadata is absent", async ({ csrf }) => {
    // GIVEN the same deployment
    const calls = await csrf.cookies();
    // WHEN the Origin names somebody else
    const answered = await calls.post({ cookie: calls.cookie, origin: "https://evil.test" });
    // THEN it is refused
    expect(answered).toEqual({ status: 403, text: "" });
  });

  it("refuses a state change with cookies, no metadata and no Origin", async ({ csrf }) => {
    // GIVEN the same deployment
    const calls = await csrf.cookies();
    // WHEN nothing at all says where the request came from
    const answered = await calls.post({ cookie: calls.cookie });
    // THEN it is refused: ambient authority with no provenance
    expect(answered).toEqual({ status: 403, text: "" });
  });

  it("is off when no composed scheme reads a cookie", async ({ csrf }) => {
    // GIVEN a deployment whose one scheme reads a header
    const calls = await csrf.headers();
    // WHEN a cross-site state change arrives carrying a cookie anyway
    const answered = await calls.post({ cookie: calls.cookie, "sec-fetch-site": "cross-site" });
    // THEN nothing is refused: the default is computed from what is composed
    expect(answered).toEqual({ status: 200, text: "<p>saved</p>" });
  });

  it("is off where the option says so, whatever is composed", async ({ csrf }) => {
    // GIVEN the cookie-scheme deployment with `csrf: false`
    const calls = await csrf.cookies(false);
    // WHEN the cross-site state change arrives
    const answered = await calls.post({ cookie: calls.cookie, "sec-fetch-site": "cross-site" });
    // THEN it is served
    expect(answered).toEqual({ status: 200, text: "<p>saved</p>" });
  });

  it("refuses an Origin no URL can parse when fetch metadata is absent", async ({ csrf }) => {
    // GIVEN the same deployment, and the `Origin: null` a sandboxed frame sends
    const calls = await csrf.cookies();
    // WHEN it arrives with the cookie
    const answered = await calls.post({ cookie: calls.cookie, origin: "null" });
    // THEN it is refused: `null` is not the host that answered
    expect(answered).toEqual({ status: 403, text: "" });
  });

  it("hands oRPC's own GET-method protection the same flag", async ({ rpcPolicy }) => {
    // GIVEN an oRPC deployment with the check on — the runtime's own half never
    // sees a GET, so this is the plugin answering or nothing is
    const calls = await rpcPolicy({ csrf: true });
    // WHEN a cross-site GET reaches the RPC mount
    const answered = await calls.read({ "sec-fetch-site": "cross-site" });
    // THEN the plugin refuses it
    expect(answered.status).toBe(403);
  });

  it("is on where the option says so, with no cookie scheme composed", async ({ csrf }) => {
    // GIVEN the header-scheme deployment with `csrf: true`
    const calls = await csrf.headers(true);
    // WHEN the cross-site state change arrives carrying a cookie
    const answered = await calls.post({ cookie: calls.cookie, "sec-fetch-site": "cross-site" });
    // THEN it is refused
    expect(answered).toEqual({ status: 403, text: "" });
  });
});
