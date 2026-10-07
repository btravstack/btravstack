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
  const messages: OutboxMessage[] = [];
  const published = new Set<number>();
  const claimed = new Set<string>();

  const pendingOf = (tenantId: string, limit: number): readonly OutboxMessage[] =>
    messages
      .filter((message) => message.tenantId === tenantId && !published.has(message.id))
      .slice(0, limit);

  return {
    append: (message) => {
      messages.push({ ...message, id: messages.length + 1, occurredAt: new Date(clock.now()) });
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
          for (const id of ids) published.add(id);
        })
        .tapFailure(() => claimed.delete(tenantId))
        .tap(() => claimed.delete(tenantId));
    },
  };
};
