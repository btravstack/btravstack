import { FindOrder } from "@btravstack/example-order-application";
import { html } from "@btravstack/http-server";
import { P } from "unthrown";

import { api } from "../../auth.js";

/**
 * The orders slice's fragment: the same tenant `ordersController` serves, and
 * reached the same way — off the `session` fork this route's `requires` opens
 * — a browser route takes the cookie the login sealed, and the JSON procedures
 * keep their bearer token — rather than off the path, which names only `id`.
 * The triage is this slice's own — `recoverErrCases` folds `OrderNotFound`
 * into a rendered row, at the same place `ordersController`'s `mapErrCases`
 * sits.
 */
export const orderRowFragment = api.HtmxGet("/orders/:id/row", { requires: [{ session: [] }] })({
  inject: {},
  unit: { find: FindOrder },
  sync: () => (context, params) =>
    context.unit.find
      .execute(params.id)
      .map((order) => html`<tr id="order-${order.id}"><td>${order.quantity}</td></tr>`)
      .recoverErrCases((matcher) =>
        matcher.with(P.tag("OrderNotFound"), () => html`<tr><td>not found</td></tr>`),
      ),
});
