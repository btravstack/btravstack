import { z } from "zod";

/**
 * Whose data this is. Branded so it cannot be swapped with the id beside it:
 * every port names both positionally, and two `string`s in a fixed order are
 * what the compiler has nothing to say about — `find(id, tenantId)` compiled,
 * and queried the wrong tenant. Only the tenant is branded, because a pair need
 * differ in ONE position to become unswappable.
 *
 * The constructor is a **cast, not a parse**, and each boundary earns that
 * differently: an oRPC input, an AMQP envelope and a Temporal activity input
 * arrive through a contract that already validated the field as a UUIDv7;
 * `OUTBOX_TENANTS` is deployment configuration, trusted rather than validated;
 * and the marked HTTP path VOUCHES for the value rather than validating it,
 * since the stand-in authenticator only checks the segment is non-empty.
 */
export const TenantIdSchema = z.uuidv7().brand("TenantId");
export type TenantId = z.infer<typeof TenantIdSchema>;
export const TenantId = (raw: string): TenantId => raw as TenantId;
