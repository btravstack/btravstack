import { TenantId } from "@btravstack/example-order-domain";
import { Unauthenticated } from "@btravstack/http";
import { ErrAsync, OkAsync } from "unthrown";

import { HttpAuthenticator } from "./auth.js";

/**
 * A stand-in, not a recommendation: `Bearer <tenantId>:<userId>`. What matters
 * for the example is the shape — an ordinary di provider on the starter's
 * port, so a real deployment swaps in JWT verification by composing a
 * different provider and changes nothing else.
 *
 * `[]` because this one needs no service; a verifier, a key set or a user
 * directory would be named there and injected the way any provider's
 * dependencies are.
 *
 * The identity is `./auth.ts`'s — the same call the slices' controllers are
 * minted from — so a token resolving to the wrong shape is a compile error
 * here, and the handlers cannot be reading a different one.
 *
 * This is also where a header becomes a **tenant**, and therefore the one
 * place this path claims the `TenantId` brand: from here on the identity
 * carries it, and neither controller casts anything.
 */
export const bearerAuthenticator = HttpAuthenticator({
  sync: () => (headers) => {
    const header = headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const [tenantId, userId] = token.split(":");
    return tenantId === undefined || tenantId === "" || userId === undefined || userId === ""
      ? ErrAsync(new Unauthenticated())
      : OkAsync({ tenantId: TenantId(tenantId), userId });
  },
});
