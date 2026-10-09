import type { AnySchema, ErrorMap, InferSchemaOutput, ProcedureContract } from "@orpc/contract";
import type { GraphQLError } from "graphql";
import { createGraphQLError } from "graphql-yoga";
import { Err, Ok, OkAsync, fromSafePromise, type AsyncResult } from "unthrown";

/**
 * A procedure's input, validated by the contract's own schemas before any call
 * — so a GraphQL argument is parsed exactly as the API will parse it, branded
 * ids included, and a malformed one is this field's `BAD_REQUEST`. Typed by
 * the procedure's declared schema; the schemas themselves are run in order.
 */
export const inputOf = <I extends AnySchema>(
  procedure: ProcedureContract<I, AnySchema, ErrorMap>,
  value: unknown,
): AsyncResult<InferSchemaOutput<I>, GraphQLError> =>
  (procedure["~orpc"].inputSchemas ?? [])
    .reduce<AsyncResult<unknown, GraphQLError>>(
      (checked, schema) =>
        checked.flatMap((current) =>
          fromSafePromise(Promise.resolve(schema["~standard"].validate(current))).flatMap(
            (outcome) =>
              outcome.issues === undefined
                ? Ok(outcome.value)
                : Err(
                    createGraphQLError(outcome.issues.map((issue) => issue.message).join("; "), {
                      extensions: { code: "BAD_REQUEST" },
                    }),
                  ),
          ),
        ),
      OkAsync(value),
    )
    .map((input) => input as InferSchemaOutput<I>);
