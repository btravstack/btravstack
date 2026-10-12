import { GraphQLError } from "graphql";

const accessMarker = Symbol("AccessRefusal");

export class AccessRefusal extends GraphQLError {
  public readonly [accessMarker]: AccessRefusal = this;

  public constructor(code: "UNAUTHORIZED" | "FORBIDDEN") {
    super("Service refused access", { extensions: { code } });
  }
}

export const accessRefusal = (cause: unknown): AccessRefusal | undefined => {
  const marked =
    typeof cause === "object" && cause !== null && accessMarker in cause
      ? cause[accessMarker]
      : cause;
  if (marked instanceof AccessRefusal) {
    return marked;
  }
  return typeof cause === "object" &&
    cause !== null &&
    "cause" in cause &&
    cause.cause instanceof AccessRefusal
    ? cause.cause
    : undefined;
};
