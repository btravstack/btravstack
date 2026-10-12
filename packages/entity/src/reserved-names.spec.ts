import { describe, expect, test } from "vitest";
import { z } from "zod";

import { Entity } from "./index.js";

describe("entity instance protocol names", () => {
  test.each(["_tag", "sameIdentityAs", "toJSON", "update", "constructor", "emit"])(
    "rejects declared %s in every builder before constructing an instance",
    (key) => {
      // GIVEN a dynamic declaration that bypasses the literal type guard
      const fields = { [key]: z.string().brand("Reserved") };
      const id = Entity.field(z.string().brand("Id"), { identity: true });
      abstract class Root extends Entity.abstract("Root")({ id }) {}
      const declarations = [
        () => Entity("Concrete")(fields),
        () => Entity.abstract("Abstract")(fields),
        () => Root.extend("Variant")(fields),
        () =>
          Entity.aggregate("Aggregate")({ id, ...fields })({
            events: z.object({ type: z.literal("Opened") }),
            opens: { Opened: () => ({ id: "a" as z.infer<typeof id.schema> }) },
            evolve: {},
          }),
      ];
      // WHEN each declaration is evaluated
      const errors = declarations.map((declare) => {
        try {
          declare();
          return undefined;
        } catch (error) {
          return error;
        }
      });
      // THEN every builder refuses the shadowed protocol member
      expect(errors).toEqual(
        declarations.map(() =>
          expect.objectContaining({ message: expect.stringContaining(`"${key}"`) }),
        ),
      );
    },
  );

  test.each(["_tag", "sameIdentityAs", "toJSON", "update", "constructor", "emit"])(
    "rejects computed %s in every builder",
    (key) => {
      // GIVEN a dynamic computed map, including fields that could expose private subclass data
      const id = Entity.field(z.string().brand("Id"), { identity: true });
      const computed = {
        [key]: Entity.computed(z.string().brand("Reserved"), () => "bad"),
      };
      abstract class Root extends Entity.abstract("Root")({ id }) {}
      const declarations = [
        () => Entity("Concrete")({ id }, { computed }),
        () => Entity.abstract("Abstract")({ id }, { computed }),
        () => Root.extend("Variant")({}, { computed }),
        () =>
          Entity.aggregate("Aggregate")({ id })({
            events: z.object({ type: z.literal("Opened") }),
            opens: { Opened: () => ({ id: "a" as z.infer<typeof id.schema> }) },
            evolve: {},
            computed,
          }),
      ];
      // WHEN each declaration is evaluated
      const errors = declarations.map((declare) => {
        try {
          declare();
          return undefined;
        } catch (error) {
          return error;
        }
      });
      // THEN no computed value can displace the projection or command protocol
      expect(errors).toEqual(
        declarations.map(() =>
          expect.objectContaining({ message: expect.stringContaining(`"${key}"`) }),
        ),
      );
    },
  );
});
