import type { Principal } from "@btravstack/example-order-api-contract";
import { HttpAuthenticator, Unauthenticated } from "@btravstack/http";
import { ErrAsync, OkAsync } from "unthrown";

/**
 * A stand-in, not a recommendation: `Bearer <tenantId>:<userId>`. What matters
 * for the example is the shape — an ordinary di provider on the starter's
 * port, so a real deployment swaps in JWT verification by composing a
 * different provider and changes nothing else.
 *
 * `[]` because this one needs no service; a verifier, a key set or a user
 * directory would be named there and injected the way any provider's
 * dependencies are. The principal type is stated at the call rather than
 * inferred, which is what makes a token resolving to the wrong shape a compile
 * error at `HttpModule(...)` instead of an `unknown` reaching a handler.
 */
export const bearerAuthenticator = HttpAuthenticator<Principal>()([], {
  sync: () => (headers) => {
    const header = headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const [tenantId, userId] = token.split(":");
    return tenantId === undefined || tenantId === "" || userId === undefined || userId === ""
      ? ErrAsync(new Unauthenticated({ reason: "no usable bearer token" }))
      : OkAsync({ tenantId, userId });
  },
});
