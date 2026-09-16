import { ConfigInvalid } from "@btravstack/config";

/** A plaintext host that never leaves the machine: the dev loop's own provider. */
// `url.hostname` keeps an IPv6 literal's brackets, so the set spells them.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether this URL may be talked to in cleartext, decided once at boot.
 *
 * `Config.url` says a value PARSES, not that it is safe — measured, it accepts
 * `javascript:`, `mailto:`, `file:` and a bare `host:port`, and it is named for
 * a property it does not check. So the scheme question is asked here, by
 * whoever knows what the URL is for.
 *
 * `https:` is always fine, `http:` on a loopback host is the dev loop, and any
 * other `http:` sends whatever the URL carries across the wire in the open.
 * That last case is `"refused"` — a `ConfigInvalid` at boot unless the caller
 * pinned the opt-in, which is where a security posture belongs and is why it is
 * an option rather than a variable: rule 6's own test, that a value whose
 * silent change is a security regression stays in the composition root.
 *
 * **One rule, two callers**, and they disagreed before this existed: `oidc()`
 * refused a cleartext issuer at boot while `jwtAuthenticator` handed an
 * `http:` JWKS URI straight to `jose`. A public key set fetched in cleartext
 * lets anything on the path substitute its own key and mint tokens this
 * process then accepts — RFC 8725 §3, and the sharper half of the two, since a
 * JWKS needs no secret to be worth attacking.
 */
export const cleartext = (url: string, allowed: boolean): boolean | "refused" => {
  const parsed = new URL(url);
  return parsed.protocol !== "http:"
    ? false
    : allowed || LOOPBACK.has(parsed.hostname)
      ? true
      : "refused";
};

/**
 * The refusal, as the `ConfigInvalid` a boot reports — one message, so the two
 * callers cannot drift into explaining the same rule differently.
 *
 * `port` is the configuration port's name and `variable` the one an operator
 * sets; `option` is the option they would pin to say they meant it and `on`
 * the call it is pinned at. The two are separate fields because this builder
 * puts the backticks in — folding the call into `option` produced
 * `` `allowInsecureIssuer` on `oidc(): true` ``, with the `: true` attached to
 * the wrong half and the backticks unbalanced.
 */
export const cleartextRefused = (args: {
  readonly port: string;
  readonly variable: string;
  readonly option: string;
  readonly on: string;
  readonly what: string;
}): ConfigInvalid =>
  new ConfigInvalid({
    port: args.port,
    issues: [
      {
        message: `must be an https: URL — in cleartext ${args.what}. Only a loopback host (localhost, 127.0.0.1, [::1]) is accepted without \`${args.option}: true\` on \`${args.on}\``,
        path: [args.variable],
      },
    ],
  });
