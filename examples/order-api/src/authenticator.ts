import { HttpAuthenticator, Unauthenticated } from "@btravstack/http";
import { ErrAsync, OkAsync } from "unthrown";

/**
 * What this deployment knows about a caller, which is **more** than the
 * contract asks for: `Principal` declares `{ tenantId }` alone, because that is
 * all the API's own semantics depend on. `userId` is the server's business and
 * never reaches a client.
 *
 * This is the layering the contract's own doc names. `HttpModule`'s gate is
 * `Auth extends { principal: Principal }`, so a subtype discharges it — adding
 * roles, an org tier or an internal id here is not a contract change. The
 * limit: a handler sees the contract's type, not this one, so a field a
 * handler needs has to be declared in the contract and becomes client-visible.
 */
type Identity = { readonly tenantId: string; readonly userId: string };

/**
 * A stand-in, not a recommendation: `Bearer <tenantId>:<userId>`. What matters
 * for the example is the shape — an ordinary di provider on the starter's
 * port, so a real deployment swaps in JWT verification by composing a
 * different provider and changes nothing else.
 *
 * `[]` because this one needs no service; a verifier, a key set or a user
 * directory would be named there and injected the way any provider's
 * dependencies are. The identity type is stated at the call rather than
 * inferred, which is what makes a token resolving to the wrong shape a compile
 * error at `HttpModule(...)` instead of an `unknown` reaching a handler.
 */
export const bearerAuthenticator = HttpAuthenticator<Identity>()([], {
  sync: () => (headers) => {
    const header = headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const [tenantId, userId] = token.split(":");
    return tenantId === undefined || tenantId === "" || userId === undefined || userId === ""
      ? ErrAsync(new Unauthenticated({ reason: "no usable bearer token" }))
      : OkAsync({ tenantId, userId });
  },
});
