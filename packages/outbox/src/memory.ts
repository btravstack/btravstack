import { systemClock, type Clock } from "@btravstack/core";
import { OkAsync } from "unthrown";

import type { OutboxMessage, OutboxStoreService } from "./outbox.js";

/** What an in-memory write appends: the envelope, without the two fields the store assigns. */
export type OutboxAppend = Omit<OutboxMessage, "id" | "occurredAt">;

/** The in-process store, plus the write half an application's in-memory adapter calls. */
export type MemoryOutboxStore = OutboxStoreService & {
  readonly append: (message: OutboxAppend) => void;
};

/**
 * An outbox held in the process: for tests, and for an application whose
 * in-memory repositories need somewhere to record their facts. Its claim is a
 * per-tenant flag, so two relays over ONE instance behave as two replicas over
 * one table do — which is the only sharing an in-process store can have.
 */
export const memoryOutboxStore = (clock: Clock = systemClock): MemoryOutboxStore => {
  let messages: OutboxMessage[] = [];
  let sequence = 0;
  const published = new Map<number, number>();
  const claimed = new Set<string>();

  const pendingOf = (tenantId: string, limit: number): readonly OutboxMessage[] =>
    messages
      .filter((message) => message.tenantId === tenantId && !published.has(message.id))
      .slice(0, limit);

  return {
    append: (message) => {
      sequence += 1;
      messages.push({ ...message, id: sequence, occurredAt: new Date(clock.now()) });
    },
    pending: (tenantId, limit) => OkAsync(pendingOf(tenantId, limit)),
    oldestPending: (tenantIds) =>
      OkAsync(
        tenantIds.flatMap((tenantId) =>
          pendingOf(tenantId, 1).map(({ occurredAt }) => ({ tenantId, occurredAt })),
        ),
      ),
    claim: (tenantId, limit, relay) => {
      if (claimed.has(tenantId)) return OkAsync();
      claimed.add(tenantId);
      return OkAsync()
        .flatMap(() => relay(pendingOf(tenantId, limit)))
        .map((ids) => {
          for (const id of ids) published.set(id, clock.now());
        })
        .tapFailure(() => claimed.delete(tenantId))
        .tap(() => claimed.delete(tenantId));
    },
    prune: (tenantId, olderThanMs, limit) => {
      if (claimed.has(tenantId)) return OkAsync(0);
      const cutoff = clock.now() - olderThanMs;
      const gone = new Set(
        messages
          .filter(
            ({ id, tenantId: owner }) =>
              owner === tenantId && (published.get(id) ?? Infinity) < cutoff,
          )
          .slice(0, limit)
          .map(({ id }) => id),
      );
      messages = messages.filter(({ id }) => !gone.has(id));
      for (const id of gone) published.delete(id);
      return OkAsync(gone.size);
    },
  };
};
