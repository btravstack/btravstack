import { oc } from "@orpc/contract";
import { z } from "zod";

export const contract = {
  hello: oc.input(z.object({ name: z.string() })).output(z.object({ message: z.string() })),
};
