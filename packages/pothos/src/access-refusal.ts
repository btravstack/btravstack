import { GraphQLError } from "graphql";

export class AccessRefusal extends GraphQLError {
  public constructor(code: "UNAUTHORIZED" | "FORBIDDEN") {
    super("Service refused access", { extensions: { code } });
  }
}

export const accessRefusal = (cause: unknown): AccessRefusal | undefined => {
  if (cause instanceof AccessRefusal) {
    return cause;
  }
  return typeof cause === "object" &&
    cause !== null &&
    "cause" in cause &&
    cause.cause instanceof AccessRefusal
    ? cause.cause
    : undefined;
};
