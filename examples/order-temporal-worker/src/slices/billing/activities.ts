import { PaymentService } from "@btravstack/example-order-application";
import { orderContract } from "@btravstack/example-order-temporal-contract";
import { TemporalWorkflowActivities } from "@btravstack/temporal-worker";
import { P } from "unthrown";

/**
 * The billing workflow's three activities, closing over the one service they
 * call. The triage is the same discipline the fulfillment slice follows: a
 * domain `Err` becomes a declared contract error, which `contract.ts` marks
 * `nonRetryable` — a refused card is a permanent answer, and asking Temporal
 * to try four more times is the bug that discipline prevents.
 *
 * The compensation declares no errors and triages nothing: `refund` promises
 * `never`, because a compensation that could answer no would leave the saga
 * stuck half-done.
 *
 * All three take the `idempotencyKey` the contract derives from their input.
 * Temporal runs an activity at least once, and this is the slice where that
 * costs money — the key is what makes the gateway collapse a retry into the
 * first attempt. It is typed `string` here because the contract declares one;
 * an activity that does not gets `undefined`, so reaching for a key nobody
 * declared is a compile error rather than a silent `undefined` on the wire.
 */
export const chargeOrder = TemporalWorkflowActivities(
  orderContract,
  "chargeOrder",
)({
  inject: { payments: PaymentService },
  sync: ({ payments }) => ({
    authorizePayment: ({ errors, idempotencyKey, input }) =>
      payments
        .authorize(input.orderId, input.amount, idempotencyKey)
        .map((authorizationId) => ({ authorizationId }))
        .mapErrCases((matcher) =>
          matcher.with(P.tag("PaymentDeclined"), (error) =>
            errors.PaymentDeclined({ id: error.id }),
          ),
        ),
    capturePayment: ({ idempotencyKey, input }) =>
      payments.capture(input.authorizationId, idempotencyKey),
    refundPayment: ({ idempotencyKey, input }) =>
      payments.refund(input.authorizationId, idempotencyKey),
  }),
});
