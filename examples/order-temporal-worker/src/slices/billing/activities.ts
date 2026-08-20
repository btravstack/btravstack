import { PaymentService } from "@btravstack/example-order-application";
import { orderContract } from "@btravstack/example-order-temporal-contract";
import { TemporalWorkflowActivities } from "@btravstack/temporal";
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
 */
export const chargeOrder = TemporalWorkflowActivities(orderContract, "chargeOrder")(
  { payments: PaymentService },
  {
    sync: ({ payments }) => ({
      authorizePayment: (args, { errors }) =>
        payments
          .authorize(args.orderId, args.amount)
          .map((authorizationId) => ({ authorizationId }))
          .mapErrCases((matcher) =>
            matcher.with(P.tag("PaymentDeclined"), (error) =>
              errors.PaymentDeclined({ id: error.id }),
            ),
          ),
      capturePayment: (args) => payments.capture(args.authorizationId),
      refundPayment: (args) => payments.refund(args.authorizationId),
    }),
  },
);
