import { z } from "zod";

/**
 * Whose data this is. Branded so it cannot be swapped with the id beside it:
 * every port in this application names both, positionally, and two `string`s
 * in a fixed order are what the compiler has nothing to say about —
 * `find(id, tenantId)` compiled, and queried the wrong tenant. Only the tenant
 * is branded, because a pair need differ in one position to become
 * unswappable; the ids stay `string` where a port names them.
 *
 * The constructor is a **cast, not a parse**, and the honesty of that rests on
 * the boundary — which differs per caller, so it is stated per boundary
 * rather than once. An oRPC input, an AMQP envelope and a Temporal activity
 * input each arrive through a contract that has already validated the field
 * as a UUIDv7, so parsing again would spend a validation per request
 * re-answering a question already answered, and `.parse()` throws besides.
 * Deployment configuration the operator wrote — `OUTBOX_TENANTS` — is
 * trusted rather than validated at all: nothing upstream of it checks the
 * shape. The HTTP-marked path is a third case, and neither of the above: its
 * stand-in `userAuth` checks only that the token's tenant segment
 * is non-empty before casting, so this boundary *vouches* for the value
 * rather than validating it — a real deployment swaps it for verification
 * that does. A brand is a compile-time fiction: nothing is asked of a caller
 * at run time, and nothing of it survives serialization.
 */
export const TenantIdSchema = z.uuidv7().brand("TenantId");
export type TenantId = z.infer<typeof TenantIdSchema>;
export const TenantId = (raw: string): TenantId => raw as TenantId;
