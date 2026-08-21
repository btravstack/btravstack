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
 * the boundary: every value that becomes one arrives through a contract that
 * has already validated it as a UUIDv7 — an oRPC input, an AMQP envelope, a
 * Temporal activity input — or through deployment configuration the operator
 * wrote. Parsing again would spend a validation per request re-answering a
 * question already answered, and `.parse()` throws besides. A brand is a
 * compile-time fiction: nothing is asked of a caller at run time, and nothing
 * of it survives serialization.
 */
export const TenantIdSchema = z.uuidv7().brand("TenantId");
export type TenantId = z.infer<typeof TenantIdSchema>;
export const TenantId = (raw: string): TenantId => raw as TenantId;
