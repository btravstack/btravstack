import { createServer } from "node:http";

const HYDRA = `${process.env.HYDRA_ADMIN_URL}/admin/oauth2/auth/requests`;
const KRATOS = `${process.env.KRATOS_ADMIN_URL}/admin/identities`;
const PORT = Number(process.env.PORT);

const json = async (url, init) => {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json().catch(() => undefined) };
};

const accept = async (pathname, challenge) => {
  if (pathname === "/logout") {
    const query = `?logout_challenge=${encodeURIComponent(challenge)}`;
    return json(`${HYDRA}/logout/accept${query}`, { method: "PUT" });
  }

  const query = `?consent_challenge=${encodeURIComponent(challenge)}`;
  const request = await json(`${HYDRA}/consent${query}`);
  if (request.status !== 200) return request;

  // Kratos passes no traits through the login accept, so the identity is read
  // here — `request.body.subject` is its id, which makes it one admin GET.
  const identity = await json(`${KRATOS}/${request.body.subject}`);
  if (identity.status !== 200) return identity;

  return json(`${HYDRA}/consent/accept${query}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_scope: request.body.requested_scope,
      grant_access_token_audience: request.body.requested_access_token_audience,
      session: {
        id_token: {
          tenant: identity.body.traits.tenant,
          email: identity.body.traits.email,
          scope: request.body.requested_scope.join(" "),
        },
      },
    }),
  });
};

/** Guarded, because writing a second time after one answer has landed is itself a crash. */
const answer = (response, status, body) => {
  if (!response.headersSent) {
    response.writeHead(status, { "content-type": "text/plain" }).end(body);
  }
};

createServer((request, response) => {
  const url = new URL(request.url, `http://localhost:${PORT}`);
  const parameter = url.pathname === "/logout" ? "logout_challenge" : "consent_challenge";
  const challenge = url.searchParams.get(parameter);

  if (challenge === null) {
    answer(response, 400, `missing ${parameter}`);
    return;
  }

  accept(url.pathname, challenge)
    .then(({ status, body }) => {
      // A challenge Hydra does not know — stale, replayed, or minted before a
      // restart — has no `redirect_to`, and answering one must never take the
      // process with it: this endpoint is shared by the whole gate.
      if (typeof body?.redirect_to !== "string") {
        answer(response, status < 500 ? 400 : 502, `${parameter} not accepted: ${status}`);
        return;
      }
      response.writeHead(302, { location: body.redirect_to }).end();
    })
    .catch((cause) => answer(response, 502, String(cause)));
}).listen(PORT, () => console.log(`consent handler on :${PORT}`));
