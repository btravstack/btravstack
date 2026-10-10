import { ORPCError } from "@orpc/client";
import "@unthrown/pothos/relay";
import type { AnySchema, ErrorMap, ProcedureContract } from "@orpc/contract";
import {
  RootFieldBuilder,
  type FieldKind,
  type ObjectRef,
  type FieldNullability,
  type InputFieldMap,
  type InputShapeFromFields,
  type OutputType,
  type SchemaTypes,
  type ShapeFromTypeParam,
  type TypeParam,
} from "@pothos/core";
import type { ConnectionShapeForType, DefaultConnectionArguments } from "@pothos/plugin-relay";
import {
  outcomeOf,
  type Caseable,
  type CaseOf,
  type Refusals,
  type ResultFieldOptions,
} from "@unthrown/pothos";
import type { ResultConnectionOptions } from "@unthrown/pothos/relay";
import { GraphQLError } from "graphql";
import { Err, P, type AsyncResult } from "unthrown";
import type { z } from "zod";

import { contractCall, contractOutput, type InvalidInput } from "./contract.js";

type ErrorClass = new (failure: never) => Error;

type Access = { readonly code: "UNAUTHORIZED" | "FORBIDDEN" };

type Procedure<Schema extends z.ZodType> = ProcedureContract<Schema, AnySchema, ErrorMap>;

type AnyProcedure = Procedure<z.ZodType>;

type Call<Context, Input, Failure> = (
  context: Context,
) => (input: Input) => AsyncResult<unknown, Failure>;

type Covered<Registry, Failure> =
  Registry extends Refusals<Failure>
    ? {}
    : { readonly uncovered: Exclude<CaseOf<Failure>, keyof Registry> };

/**
 * `t.procedureField`'s options: `resultField`'s, with `call`, `input` and
 * `output` in place of `resolve`, and the builder's `orpc.refusals` in place
 * of `refusals`. The registry must cover every error the procedure declares,
 * and `InvalidInput`; an uncovered case is a compile error naming it.
 */
export type ProcedureFieldOptions<
  Types extends SchemaTypes,
  ParentShape,
  Type extends TypeParam<Types>,
  Nullable extends FieldNullability<Type>,
  Args extends InputFieldMap,
  Kind extends FieldKind,
  Schema extends z.ZodType,
  Failure,
> = Omit<
  ResultFieldOptions<Types, ParentShape, Type, Nullable, Args, Kind, Failure>,
  "refusals" | "resolve"
> & {
  readonly call: Call<Types["Context"], z.input<Schema>, Failure>;
  readonly input: (
    args: InputShapeFromFields<Args>,
    parent: ParentShape,
  ) => NoInfer<z.input<Schema>>;
  readonly output: z.ZodType<ShapeFromTypeParam<Types, Type, false>>;
  readonly tap?: (value: ShapeFromTypeParam<Types, Type, false>, context: Types["Context"]) => void;
} & Covered<Types["Refusals"], Exclude<Failure, Access> | InvalidInput>;

/**
 * `t.procedureConnection`'s options: `resultConnection`'s, with `call`,
 * `input` and `output` in place of `resolve`, `connection` folding the
 * decoded page into the connection's shape, and an optional `connectionType`
 * for fields beside its edges and page info.
 */
export type ProcedureConnectionOptions<
  Types extends SchemaTypes,
  ParentShape,
  Type extends OutputType<Types>,
  Nullable extends boolean,
  EdgeNullability extends FieldNullability<[unknown]>,
  NodeNullability extends boolean,
  Args extends InputFieldMap,
  Kind extends FieldKind,
  Schema extends z.ZodType,
  Page,
  Failure,
  Connection extends ConnectionShapeForType<Types, Type, false, EdgeNullability, NodeNullability> =
    ConnectionShapeForType<Types, Type, false, EdgeNullability, NodeNullability>,
> = Omit<
  ResultConnectionOptions<
    Types,
    ParentShape,
    Type,
    Nullable,
    EdgeNullability,
    NodeNullability,
    Args,
    Kind,
    Failure,
    Connection
  >,
  "refusals" | "resolve"
> & {
  readonly call: Call<Types["Context"], z.input<Schema>, Failure>;
  readonly input: (
    args: DefaultConnectionArguments & InputShapeFromFields<Args>,
    parent: ParentShape,
  ) => NoInfer<z.input<Schema>>;
  readonly output: z.ZodType<Page>;
  readonly connectionType?: ObjectRef<Types, Connection>;
  readonly connection: (
    page: Page,
    args: DefaultConnectionArguments & InputShapeFromFields<Args>,
  ) => Connection;
} & Covered<Types["Refusals"], Exclude<Failure, Access> | InvalidInput>;

declare global {
  export namespace PothosSchemaTypes {
    // oxlint-disable-next-line typescript/consistent-type-definitions -- a module augmentation must be an interface; a type alias cannot merge
    export interface UserSchemaTypes {
      Refusals: Readonly<Record<string, ErrorClass>>;
    }

    // oxlint-disable-next-line typescript/consistent-type-definitions -- a module augmentation must be an interface; a type alias cannot merge
    export interface ExtendDefaultTypes<PartialTypes extends Partial<UserSchemaTypes>> {
      Refusals: PartialTypes["Refusals"] & {};
    }

    // oxlint-disable-next-line typescript/consistent-type-definitions -- a module augmentation must be an interface; a type alias cannot merge
    export interface SchemaBuilderOptions<Types extends SchemaTypes> {
      orpc?: { readonly refusals: Types["Refusals"] };
    }

    // oxlint-disable-next-line typescript/consistent-type-definitions -- a module augmentation must be an interface; a type alias cannot merge
    export interface RootFieldBuilder<
      Types extends SchemaTypes,
      ParentShape,
      Kind extends FieldKind = FieldKind,
    > {
      /**
       * A field answering an oRPC procedure: `input` maps the field's
       * arguments to the procedure's input, the contract validates it before
       * `call` runs, and `output` decodes the answer. A declared error is
       * answered as its registered refusal, a member of the field's result
       * union; the service refusing access is GraphQL's own error, with
       * `extensions.code`.
       */
      procedureField: <
        Type extends TypeParam<Types>,
        Schema extends z.ZodType,
        Failure,
        Nullable extends FieldNullability<Type> = Types["DefaultFieldNullability"],
        Args extends InputFieldMap = {},
      >(
        procedure: Procedure<Schema>,
        options: ProcedureFieldOptions<
          Types,
          ParentShape,
          Type,
          Nullable,
          Args,
          Kind,
          Schema,
          Failure
        >,
      ) => FieldRef<Types, ShapeFromTypeParam<Types, Type, Nullable>, Kind>;

      /**
       * A Relay connection answering an oRPC procedure: `procedureField`'s
       * contract, with the decoded page folded by `connection`.
       */
      procedureConnection: <
        Type extends OutputType<Types>,
        Schema extends z.ZodType,
        Page,
        Failure,
        Nullable extends boolean,
        Args extends InputFieldMap = {},
        EdgeNullability extends FieldNullability<[unknown]> = Types["DefaultEdgesNullability"],
        NodeNullability extends boolean = Types["DefaultNodeNullability"],
        Connection extends ConnectionShapeForType<
          Types,
          Type,
          false,
          EdgeNullability,
          NodeNullability
        > = ConnectionShapeForType<Types, Type, false, EdgeNullability, NodeNullability>,
      >(
        procedure: Procedure<Schema>,
        options: ProcedureConnectionOptions<
          Types,
          ParentShape,
          Type,
          Nullable,
          EdgeNullability,
          NodeNullability,
          Args,
          Kind,
          Schema,
          Page,
          Failure,
          Connection
        >,
      ) => FieldRef<
        Types,
        ConnectionShapeForType<Types, Type, Nullable, EdgeNullability, NodeNullability>
      >;
    }
  }
}

/**
 * The refusals a procedure can answer, read from `registry`: one per error
 * code its contract declares, and `InvalidInput`. A code the registry lacks is
 * left out.
 */
export const refusalsOf = <Failure>(
  registry: Readonly<Record<string, ErrorClass>>,
  procedure: AnyProcedure,
): Refusals<Failure> =>
  Object.fromEntries(
    [...Object.keys(procedure["~orpc"].errorMap), "InvalidInput"].flatMap((code) => {
      const Refusal = registry[code];
      return Refusal === undefined ? [] : [[code, Refusal]];
    }),
  ) as Refusals<Failure>;

const accessRefusalOf = (cause: unknown): Error | undefined =>
  cause instanceof ORPCError && (cause.code === "UNAUTHORIZED" || cause.code === "FORBIDDEN")
    ? new GraphQLError("Service refused access", { extensions: { code: cause.code } })
    : undefined;

/**
 * `call` handed the input the procedure's contract accepts, its answer decoded
 * by `output`. `UNAUTHORIZED` and `FORBIDDEN`, declared or not, leave the
 * error channel: they travel as a `GraphQLError` carrying the code in
 * `extensions.code`, an error of the operation, never a refusal of the field.
 */
export const callProcedure = <Schema extends z.ZodType, Output, Failure>(
  procedure: Procedure<Schema>,
  input: unknown,
  call: (input: z.input<Schema>) => AsyncResult<unknown, Failure>,
  output: z.ZodType<Output>,
): AsyncResult<Output, Exclude<Failure, Access> | InvalidInput> =>
  contractCall(procedure, input, (validated) => withoutAccess(call(validated)))
    .flatMap((value) => contractOutput(output, value))
    .recoverDefect((cause) => {
      // oxlint-disable-next-line unthrown/no-throw -- a defect stays one: an access refusal travels as GraphQL's own error
      throw accessRefusalOf(cause) ?? cause;
    });

function withoutAccess<Value, Failure>(
  called: AsyncResult<Value, Failure>,
): AsyncResult<Value, Exclude<Failure, Access>> {
  return called.flatMapErrCases((matcher, defect) =>
    matcher
      .with({ code: "UNAUTHORIZED" }, { code: "FORBIDDEN" }, (failure) => defect(failure))
      // oxlint-disable-next-line unthrown/no-catch-all-pattern -- `Failure` is generic, so the catch-all is the only arm that passes every other case through
      .with(P._, (failure) => Err(failure)),
  );
}

/**
 * What a DataLoader answers for one key read through `procedure`: the decoded
 * value, or an `Error` — the registered refusal for a declared error, the
 * defect otherwise — so one key's failure never fails the batch.
 *
 * **It answers a `Promise`, and that is the boundary**: a DataLoader's batch
 * function answers a value or an `Error` per key.
 */
export const loadProcedure = async <Schema extends z.ZodType, Output, Failure extends Caseable>(
  registry: Readonly<Record<string, ErrorClass>>,
  procedure: Procedure<Schema>,
  call: (input: z.input<Schema>) => AsyncResult<unknown, Failure>,
  input: unknown,
  output: z.ZodType<Output>,
): Promise<Output | Error> =>
  outcomeOf<Output, Caseable>(
    callProcedure(procedure, input, call, output),
    refusalsOf<Caseable>(registry, procedure),
  );

/**
 * The `errors` option of a field that reads `procedure` through
 * `loadProcedure`: the registered refusals it can answer, as the field's
 * result union.
 */
export const procedureErrors = (
  registry: Readonly<Record<string, ErrorClass>>,
  procedure: AnyProcedure,
): { readonly types: (new (...args: never[]) => Error)[] } => ({
  types: Object.values(refusalsOf(registry, procedure)),
});

export const defineProcedureFields = (): void => {
  const fieldBuilder = RootFieldBuilder.prototype as PothosSchemaTypes.RootFieldBuilder<
    SchemaTypes,
    unknown
  >;

  fieldBuilder.procedureField = function procedureField(
    procedure,
    { call, input, output, tap, ...options },
  ) {
    return this.resultField({
      ...options,
      refusals: refusalsOf(this.builder.options.orpc?.refusals ?? {}, procedure),
      resolve: (parent: unknown, args: object, context: object) =>
        callProcedure(procedure, input(args as never, parent), call(context), output).tap(
          (value) => {
            tap?.(value, context);
          },
        ),
    } as never);
  };

  fieldBuilder.procedureConnection = function procedureConnection(
    procedure,
    { call, input, output, connection, connectionType, ...options },
  ) {
    return this.resultConnection(
      {
        ...options,
        refusals: refusalsOf(this.builder.options.orpc?.refusals ?? {}, procedure),
        resolve: (parent: unknown, args: object, context: object) =>
          callProcedure(procedure, input(args as never, parent), call(context), output).map(
            (page): object => connection(page, args as never),
          ),
      } as never,
      connectionType,
    );
  };
};
