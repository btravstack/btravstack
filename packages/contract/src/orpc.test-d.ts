import { oc, type } from "@orpc/contract";
import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";

import { contractInputSchema, contractOutputSchema } from "./orpc.js";

describe("orpc schema types", () => {
  test("preserves each schema and its client and server sides", () => {
    const amount = z.codec(z.string(), z.bigint(), { decode: BigInt, encode: String });
    const input = z.object({ amount, limit: z.number().default(20) });
    const output = z.object({ receipt: amount.brand("Receipt") });
    const procedure = oc.input(input).output(output);
    const request = contractInputSchema(procedure);
    const response = contractOutputSchema(procedure);

    expectTypeOf(request).toEqualTypeOf(input);
    expectTypeOf(response).toEqualTypeOf(output);
    expectTypeOf<z.input<typeof request>>().toEqualTypeOf<{
      amount: string;
      limit?: number | undefined;
    }>();
    expectTypeOf<z.output<typeof request>>().toEqualTypeOf<{ amount: bigint; limit: number }>();
    expectTypeOf<z.input<typeof response>>().toEqualTypeOf<{ receipt: string }>();
    expectTypeOf<z.output<typeof response>>().toEqualTypeOf<{
      receipt: bigint & z.$brand<"Receipt">;
    }>();
    expectTypeOf(request.pick({ amount: true }).shape.amount).toEqualTypeOf(amount);
    expectTypeOf(response.extend({ accepted: z.boolean() }).shape.receipt).toEqualTypeOf(
      output.shape.receipt,
    );
  });

  test("refuses absent and non-Zod schema types", () => {
    // @ts-expect-error no declared input schema
    contractInputSchema(oc.output(z.string()));
    // @ts-expect-error no declared output schema
    contractOutputSchema(oc.input(z.string()));
    // @ts-expect-error Standard Schema alone cannot supply Zod composition
    contractInputSchema(oc.input(type<string>()));
    // @ts-expect-error Standard Schema alone cannot supply Zod composition
    contractOutputSchema(oc.output(type<string>()));
  });
});
