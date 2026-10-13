import { Module } from "@btravstack/di";

import { orderAudit } from "./handler.js";

/**
 * The audit slice: same shape as the notifications one, its own consumer and
 * nothing else the rest of the worker can see. It imports no vertical either
 * — a subscriber owns no domain and no persistence — but its consumer differs
 * from the notifier's in what matters for an auditor: its own queue and retry
 * budget in the contract, and its own answer to the drain deadline — it keeps
 * writing through the drain window rather than leaving a delivery un-acked.
 *
 * `exports: [orderAudit]` is the provider, not a port class: `AmqpHandler`
 * mints the port from the contract key, so there is nothing to name.
 */
export const AuditSlice = Module("AuditSlice")({
  provides: [orderAudit],
  exports: [orderAudit],
});
