import type { AnySchema, ErrorMap, ProcedureContract } from "@orpc/contract";
import { z } from "zod";

/**
 * The procedure's single Zod input schema, preserving its identity and exact
 * type so callers can derive shapes and distinguish wire input from decoded
 * handler input. A missing, non-Zod or chained schema throws at composition;
 * selecting one stage would discard part of the procedure's validation.
 */
export const contractInputSchema = <
  Input extends z.ZodType,
  Output extends AnySchema,
  Errors extends ErrorMap,
>(
  procedure: ProcedureContract<Input, Output, Errors>,
): Input => {
  const [schema] = z
    .tuple([z.custom<Input>((value) => value instanceof z.ZodType)])
    .parse(procedure["~orpc"].inputSchemas);
  return schema;
};

/**
 * The procedure's single Zod output schema, preserving its identity and exact
 * type. Its input is what the handler produces; its output is what a client
 * receives after validation. A missing, non-Zod or chained schema throws at
 * composition rather than silently dropping a validation stage.
 */
export const contractOutputSchema = <
  Input extends AnySchema,
  Output extends z.ZodType,
  Errors extends ErrorMap,
>(
  procedure: ProcedureContract<Input, Output, Errors>,
): Output => {
  const [schema] = z
    .tuple([z.custom<Output>((value) => value instanceof z.ZodType)])
    .parse(procedure["~orpc"].outputSchemas);
  return schema;
};
