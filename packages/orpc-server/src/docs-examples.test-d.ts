import { oc, type RouterContractClient } from "@orpc/contract";
import { openapi } from "@orpc/openapi";
import { ErrAsync } from "unthrown";
import { z } from "zod";

import { defineHttp } from "./define-http.js";

const contract = {
  find: oc
    .meta(openapi({ method: "GET", path: "/items/{id}" }))
    .input(z.object({ id: z.string() }))
    .output(z.object({ id: z.string() }))
    .errors({ ITEM_MISSING: { status: 404, data: z.object({ id: z.string() }) } }),
};

defineHttp().OrpcRouter(contract)({
  sync: () => ({
    find: ({ errors }, input) => ErrAsync(errors.ITEM_MISSING({ data: { id: input.id } })),
  }),
});

declare const client: RouterContractClient<typeof contract>;
const output: Promise<{ id: string }> = client.find({ id: "42" });

defineHttp().OrpcRouter(contract)({
  sync: () => ({
    find: ({ errors }) =>
      // @ts-expect-error -- a status declaration must preserve the error's data schema
      ErrAsync(errors.ITEM_MISSING({ data: { id: 42 } })),
  }),
});
