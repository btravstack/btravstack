import { contractInputSchema as contractInput } from "@btravstack/contract/orpc";
import type { AnySchema, ErrorMap, ProcedureContract } from "@orpc/contract";
import {
  Err,
  fromPromise,
  fromSafePromise,
  fromSafeThrowable,
  TaggedError,
  type AsyncResult,
} from "unthrown";
import { z } from "zod";

export { contractInput };

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
 * refinements included — or `InvalidInput` without calling it. A schema with a
 * transform cannot be encoded back: `call` gets the input as given, which the
 * contract admitted. A contract whose input is not one Zod
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
          ? wireInput(schema, parsed.data, input as z.input<Schema>)
          : Err(new InvalidInput({ issues: parsed.error.issues })),
      ),
    )
    .flatMap((validated) => call(validated));

// A schema holding a unidirectional transform has no wire spelling to encode
// back to: the input goes as given, already admitted by the contract, which the
// service parses again.
const wireInput = <Schema extends z.ZodType>(
  schema: Schema,
  parsed: z.output<Schema>,
  given: z.input<Schema>,
): AsyncResult<z.input<Schema>, never> =>
  fromPromise(z.encodeAsync(schema, parsed), (cause, defect) =>
    cause instanceof z.core.$ZodEncodeError ? ("Unencodable" as const) : defect(cause),
  ).recoverErrCases((matcher) => matcher.with("Unencodable", () => given));

/**
 * A procedure's answer decoded by `schema` — the shape the GraphQL field
 * resolves, codecs run. An answer the schema refuses is a defect: the service
 * broke its own contract.
 */
export const contractOutput = <Schema extends z.ZodType>(schema: Schema, value: unknown) =>
  fromSafePromise(schema.parseAsync(value));
