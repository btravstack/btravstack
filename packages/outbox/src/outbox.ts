import { Port } from "@btravstack/di";
import type { AsyncResult } from "unthrown";

/**
 * One committed fact awaiting broadcast: a row of the outbox table, as the
 * relay reads it.
 *
 * The row IS the envelope. `tenantId` is whose fact it is, and the unit the
 * relay claims by; `kind` is which sort of thing changed; `subjectId` is which
 * one, and the key a reader compacts on; `payload` is the application's own
 * encoding, handed to the publisher untouched — a `null` payload is the
 * **tombstone**, the last word about a subject. `id` is the outbox sequence,
 * and the order the relay publishes a tenant's facts in.
 */
export type OutboxMessage = {
  readonly id: number;
  readonly tenantId: string;
  readonly kind: string;
  readonly subjectId: string;
  readonly payload: string | null;
  readonly occurredAt: Date;
};

/**
 * What a store answers for the relay. Both operations promise `never`: a
 * database that will not answer is a defect the relay observes and retries,
 * not a domain outcome.
 */
export type OutboxStoreService = {
  /**
   * A tenant's oldest unpublished messages, in outbox order, at most `limit`.
   * A read and nothing more — it claims nothing, which is what lets the health
   * check and a spec look without racing the relay.
   */
  readonly pending: (
    tenantId: string,
    limit: number,
  ) => AsyncResult<readonly OutboxMessage[], never>;
  /**
   * When each of `tenantIds`' oldest unpublished message was written, for the
   * tenants that have one — on ONE connection however many tenants are asked
   * about, because the health check asks on every `/healthz`, and a connection
   * per tenant would queue the pool behind the probe meant to report it.
   */
  readonly oldestPending: (
    tenantIds: readonly string[],
  ) => AsyncResult<readonly { readonly tenantId: string; readonly occurredAt: Date }[], never>;
  /**
   * Claims a tenant's oldest unpublished messages, hands them to `relay`, and
   * marks published exactly the ids `relay` answers — all under one claim, so
   * no other caller holding the same store is handed the same tenant until it
   * is released.
   *
   * A tenant another caller has claimed is **skipped, not waited for**: the
   * call answers `Ok` without running `relay`. A defect from `relay` releases
   * the claim and marks nothing.
   */
  readonly claim: (
    tenantId: string,
    limit: number,
    relay: (batch: readonly OutboxMessage[]) => AsyncResult<readonly number[], never>,
  ) => AsyncResult<void, never>;
};

/**
 * Where the relay reads from. An application provides it — from
 * `@btravstack/outbox/prisma`'s `prismaOutboxStore`, `memoryOutboxStore`, or
 * an adapter of its own — beside the transaction that writes the rows, which
 * stays the application's.
 */
export class OutboxStore extends Port("OutboxStore")<OutboxStoreService> {}

/**
 * Whatever tagged error the publisher models — a broker that refused, a
 * message the contract rejects. The relay reports it and acts on none of it,
 * so the type asks for a tag and nothing else.
 */
export type PublishRefused = { readonly _tag: string };

/**
 * What "publish" means, which only the application knows: the transport, the
 * contract and the decoding of `payload`.
 *
 * Any `Err` is a message left pending: the relay stops the tenant's batch
 * there, so a later fact never overtakes it, and tries again after its
 * back-off.
 */
export type OutboxPublisherService = {
  readonly publish: (message: OutboxMessage) => AsyncResult<void, PublishRefused>;
};

export class OutboxPublisher extends Port("OutboxPublisher")<OutboxPublisherService> {}
