import { describe, test } from "vitest";

import type { Principal, SchemesOf } from "./principal.js";

type Schemes = {
  readonly user: { readonly userId: string; readonly tenantId: string };
  readonly service: { readonly appId: string };
};

describe("Principal", () => {
  test("one scheme is the identity, bare", () => {
    const one = null as unknown as Principal<"user", Schemes>;
    const tenantId: string = one.tenantId;
    void tenantId;
  });

  test("two schemes are a tagged union, narrowed exhaustively", () => {
    const many = null as unknown as Principal<"user" | "service", Schemes>;
    const read = (): string => {
      switch (many.scheme) {
        case "user":
          return many.identity.tenantId;
        case "service":
          return many.identity.appId;
      }
    };
    void read;
  });

  test("the one-scheme form is not tagged", () => {
    const one = null as unknown as Principal<"user", Schemes>;
    // @ts-expect-error -- a one-scheme principal has no `scheme` key
    void one.scheme;
  });

  test("the many-scheme form is not bare", () => {
    const many = null as unknown as Principal<"user" | "service", Schemes>;
    // @ts-expect-error -- a two-scheme principal must be narrowed first
    void many.tenantId;
  });

  test("a public leaf has nothing to read", () => {
    const none = null as unknown as Principal<never, Schemes>;
    // @ts-expect-error -- `never` has no properties
    void none.userId;
  });

  test("a dropped switch arm is an error", () => {
    const many = null as unknown as Principal<"user" | "service", Schemes>;
    // @ts-expect-error -- not every path returns: "service" is unhandled
    const read = (): string => {
      switch (many.scheme) {
        case "user":
          return many.identity.tenantId;
      }
    };
    void read;
  });

  test("SchemesOf flattens requirements to their scheme names", () => {
    const names = null as unknown as SchemesOf<
      [{ readonly user: readonly ["orders:export"] }, { readonly service: readonly [] }]
    >;
    const asUnion: "user" | "service" = names;
    void asUnion;
  });
});
