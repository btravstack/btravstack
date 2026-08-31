import { fragments } from "@btravstack/example-order-api-contract";
import { FindOrder } from "@btravstack/example-order-application";
import { html } from "@btravstack/http-server";
import { P } from "unthrown";

import { api } from "../../auth.js";

/**
 * The orders slice's fragment: the same tenant read as `ordersController`,
 * off `context.principal` rather than the path, which names only `id`. The
 * triage is this slice's own — `recoverErrCases` folds `OrderNotFound` into a
 * rendered row, at the same place `ordersController`'s `mapErrCases` sits.
 */
export const orderRowFragment = api.HtmxController(fragments, "orderRow")(
  { find: FindOrder },
  {
    sync:
      ({ find }) =>
      (context, params) =>
        find
          .execute(context.principal.tenantId, params.id)
          .map((order) => html`<tr id="order-${order.id}"><td>${order.quantity}</td></tr>`)
          .recoverErrCases((matcher) =>
            matcher.with(P.tag("OrderNotFound"), () => html`<tr><td>not found</td></tr>`),
          ),
  },
);
