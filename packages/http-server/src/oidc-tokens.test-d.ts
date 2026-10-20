import { Env } from "@btravstack/config";
import { noObserverMember } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { OkAsync } from "unthrown";

import {
  oidcTokens,
  OidcTokens,
  OidcTokenStore,
  type OidcTokensService,
  type OidcTokenStoreService,
  type OidcTokensOptions,
} from "./oidc-tokens.js";
import { oidc } from "./oidc.js";
import { sessionCodec } from "./session.js";

class StaffTokens extends Port("StaffTokens")<OidcTokensService> {}
class WrongTokens extends Port("WrongTokens")<{ readonly unrelated: true }> {}

const pins = {
  issuer: "https://issuer.example",
  clientId: "staff",
  clientSecret: "secret",
} as const;
const manager = oidcTokens(pins);
const staff = oidcTokens({ ...pins, port: StaffTokens });
const staffPort: typeof StaffTokens = staff.port;
const defaultPort: typeof OidcTokens = manager.port;

// @ts-expect-error a token manager must implement the server-side lifecycle capability
const wrongLogin = oidc()({ principal: (claims) => claims, tokens: WrongTokens });

const missingStore = Module("MissingTokenStore")({
  provides: [
    Provider(Env)({ inject: {}, value: {} }),
    noObserverMember,
    sessionCodec({ keys: ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"] }),
    manager,
  ],
  exports: [manager.port],
});
// @ts-expect-error nothing provides HttpOidcTokenStore; a process-local fallback is not synthesized
Module.scoped(missingStore, (ctx) => OkAsync(ctx.get(manager.port)));

declare const store: OidcTokenStoreService;
const backed = Module("BackedTokens")({
  imports: [missingStore],
  provides: [Provider(OidcTokenStore)({ inject: {}, value: store })],
  exports: [manager.port],
});
Module.scoped(backed, (ctx) => ctx.get(manager.port).accessToken(undefined));

declare const options: OidcTokensOptions;
const dynamic = oidcTokens(options);
// @ts-expect-error an optional custom port cannot promise the default port identity
const assumedDefault: typeof OidcTokens = dynamic.port;
