import type { AnySchema, ErrorMap, ProcedureContract } from "@orpc/contract";
import { Err, fromSafePromise, fromSafeThrowable, TaggedError, type AsyncResult } from "unthrown";
import { z } from "zod";

/**
 * The one Zod schema a procedure's contract declares for its input, typed as
 * declared — to derive a GraphQL argument's shape from it (`.shape`, a
 * `z.preprocess` around it) when the schema is built.
 *
 * A procedure whose contract holds anything but exactly one Zod input schema
 * is a mistake in the schema's source, not a request's: it throws, once, as
 * the schema is built.
 */
export const contractInput = <
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
 * An input the procedure's contract refuses, caught before the procedure is
 * called: each of the contract's issues, with its message and path.
 */
export class InvalidInput extends TaggedError("InvalidInput")<{
  readonly issues: readonly { readonly message: string; readonly path: readonly PropertyKey[] }[];
}> {
  public override message = "Input does not satisfy the service contract";
}

/**
 * `call`, handed the input as the procedure's contract parses it and encodes
 * it back for the wire — its defaults applied, its codecs run, asynchronous
 * refinements and transforms included — or `InvalidInput` without calling it. A contract whose input is not one Zod
 * schema is a defect.
 */
export const contractCall = <
  Schema extends z.ZodType,
  OutputSchema extends AnySchema,
  Errors extends ErrorMap,
  Output,
  Failure,
>(
  procedure: ProcedureContract<Schema, OutputSchema, Errors>,
  input: unknown,
  call: (validated: z.input<Schema>) => AsyncResult<Output, Failure>,
): AsyncResult<Output, Failure | InvalidInput> =>
  fromSafeThrowable(() => contractInput(procedure))()
    .toAsync()
    .flatMap((schema) =>
      fromSafePromise(schema.safeParseAsync(input)).flatMap((parsed) =>
        parsed.success
          ? fromSafePromise(z.encodeAsync(schema, parsed.data))
          : Err(new InvalidInput({ issues: parsed.error.issues })),
      ),
    )
    .flatMap((validated) => call(validated));

/**
 * A procedure's answer decoded by `schema` — the shape the GraphQL field
 * resolves, codecs run. An answer the schema refuses is a defect: the service
 * broke its own contract.
 */
export const contractOutput = <Schema extends z.ZodType>(schema: Schema, value: unknown) =>
  fromSafePromise(schema.parseAsync(value));
