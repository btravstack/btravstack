import { createServer } from "node:http";

const HYDRA = `${process.env.HYDRA_ADMIN_URL}/admin/oauth2/auth/requests`;
const KRATOS = `${process.env.KRATOS_ADMIN_URL}/admin/identities`;
const PORT = Number(process.env.PORT);

const json = (url, init) => fetch(url, init).then((response) => response.json());

const accept = async (pathname, challenge) => {
  if (pathname === "/logout") {
    const query = `?logout_challenge=${encodeURIComponent(challenge)}`;
    const done = await json(`${HYDRA}/logout/accept${query}`, { method: "PUT" });
    return done.redirect_to;
  }

  const query = `?consent_challenge=${encodeURIComponent(challenge)}`;
  const request = await json(`${HYDRA}/consent${query}`);
  // Kratos passes no traits through the login accept, so the identity is read
  // here — `request.subject` is its id, which makes it one admin GET.
  const { traits } = await json(`${KRATOS}/${request.subject}`);
  const accepted = await json(`${HYDRA}/consent/accept${query}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_scope: request.requested_scope,
      grant_access_token_audience: request.requested_access_token_audience,
      session: {
        id_token: {
          tenant: traits.tenant,
          email: traits.email,
          scope: request.requested_scope.join(" "),
        },
      },
    }),
  });
  return accepted.redirect_to;
};

createServer((request, response) => {
  const url = new URL(request.url, `http://localhost:${PORT}`);
  const parameter = url.pathname === "/logout" ? "logout_challenge" : "consent_challenge";
  const challenge = url.searchParams.get(parameter);

  if (challenge === null) {
    response.writeHead(400, { "content-type": "text/plain" }).end(`missing ${parameter}`);
    return;
  }

  accept(url.pathname, challenge).then(
    (location) => response.writeHead(302, { location }).end(),
    (cause) => response.writeHead(502, { "content-type": "text/plain" }).end(String(cause)),
  );
}).listen(PORT, () => console.log(`consent handler on :${PORT}`));
