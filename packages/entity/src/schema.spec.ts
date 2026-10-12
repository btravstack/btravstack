import { fromSchema } from "@unthrown/standard-schema";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import { Entity } from "./index.js";

const OrgId = z.uuid().brand("OrgId");
const Slug = z.string().min(1).brand("Slug");

class Organization extends Entity("Organization")(
  { id: OrgId, slug: Slug },
  {
    invariants: [
      Entity.invariant({
        code: "RESERVED_SLUG",
        ensure: (d) => d.slug !== "reserved",
        message: "slug must not be reserved",
      }),
    ],
  },
) {}

const raw = { id: "0199b1f4-1b1e-7000-8000-000000000000", slug: "acme" };

test("the class is itself a schema, so zod parses input to an instance", () => {
  // no `.parse` on the class by design — `make` is the direct route, and zod
  // reaches the schema through the internal slots
  expect(z.array(Organization).parse([raw])[0]).toBeInstanceOf(Organization);
  expect(Organization.make(raw).getOrThrow()).toBeInstanceOf(Organization);
});

test("the class nests inside a zod object and an array", () => {
  expect(z.object({ owner: Organization }).parse({ owner: raw }).owner).toBeInstanceOf(
    Organization,
  );
  const many = z.array(Organization).parse([raw, raw]);
  expect(many[0]).toBeInstanceOf(Organization);
});

test("the class is the Standard Schema entry point", () => {
  const parse = fromSchema(Organization);
  expect(parse(raw).getOrThrow()).toBeInstanceOf(Organization);
  expect(parse({ id: "nope", slug: "" }).isErr()).toBe(true);
});

test("the schema slots are not enumerable on the class", () => {
  expect(Object.keys(Organization)).not.toContain("_zod");
  expect(Object.keys(Organization)).not.toContain("~standard");
});

test("the schema is built once and reused", () => {
  expect(Organization).toBe(Organization);
});

test("the class carries ~standard, so a framework accepts it directly", () => {
  expect("~standard" in (Organization as object)).toBe(true);
});

test("a defect during make propagates instead of becoming a validation issue", () => {
  class Buggy extends Entity("Buggy")(
    { id: OrgId },
    {
      invariants: [
        Entity.invariant({
          code: "UNREACHABLE",
          ensure: () => {
            // deliberately simulate an unmodeled defect, to pin that the schema
            // lets it propagate rather than folding it into a zod issue
            // oxlint-disable-next-line unthrown/no-throw
            throw new Error("boom");
          },
          message: "unreachable — the predicate always throws",
        }),
      ],
    },
  ) {}
  expect(() => z.array(Buggy).parse([{ id: raw.id }])).toThrow("boom");
});

test("a nested entity's field failure reports the full path, not just the member", () => {
  const result = z.object({ owner: Organization }).safeParse({ owner: { id: raw.id, slug: "" } });
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues[0]?.path).toEqual(["owner", "slug"]);
  }
});

test("a nested invariant failure lands on the member itself, having no path", () => {
  const result = z
    .object({ owner: Organization })
    .safeParse({ owner: { ...raw, slug: "reserved" } });
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues[0]?.path).toEqual(["owner"]);
    expect(result.error.issues[0]?.message).toBe("slug must not be reserved");
  }
});

describe("one construction parse at every nesting depth", () => {
  test("a type-changing field survives two parent entities", () => {
    // GIVEN a field whose output cannot be parsed as its input
    let calls = 0;
    class Leaf extends Entity("Leaf")({
      value: z
        .string()
        .transform((value) => {
          calls++;
          return value.length;
        })
        .brand("Length"),
    }) {}
    class Holder extends Entity("Holder")({ leaf: Leaf }) {}
    class Root extends Entity("Root")({ holder: Holder }) {}
    // WHEN raw input passes through two parents
    const made = Root.make({ holder: { leaf: { value: "abc" } } }).map((root) => ({
      value: root.holder.leaf.value,
      constructors: [root.constructor, root.holder.constructor, root.holder.leaf.constructor],
      calls,
    }));
    // THEN each field is parsed once and every class instance is retained
    expect(made).toBeOkWith({ value: 3, constructors: [Root, Holder, Leaf], calls: 1 });
  });

  test("an appending transform runs once through arrays and two parents", () => {
    // GIVEN a non-idempotent field transform and a computed field
    let calls = 0;
    class Leaf extends Entity("Leaf")(
      {
        value: z
          .string()
          .transform((value) => {
            calls++;
            return `${value}!`;
          })
          .brand("Value"),
      },
      {
        computed: {
          shout: Entity.computed(z.string().brand("Shout"), (d) => d.value.toUpperCase()),
        },
      },
    ) {}
    class Holder extends Entity("Holder")({ leaves: z.array(Leaf) }) {}
    class Root extends Entity("Root")({ holder: Holder }) {}
    // WHEN raw input passes through the array and both parents
    const made = Root.make({ holder: { leaves: [{ value: "abc" }] } }).map((root) => ({
      json: JSON.parse(JSON.stringify(root)) as unknown,
      leafClass: root.holder.leaves[0]!.constructor,
      calls,
    }));
    // THEN computed data derives from the once-transformed field
    expect(made).toBeOkWith({
      json: { holder: { leaves: [{ value: "abc!", shout: "ABC!" }] } },
      leafClass: Leaf,
      calls: 1,
    });
  });

  test("a nested invariant retains its code and complete array path", () => {
    // GIVEN a leaf rule nested below an array and another entity
    class Leaf extends Entity("Leaf")(
      { value: z.string().brand("Value") },
      {
        invariants: [
          Entity.invariant({
            code: "RESERVED",
            ensure: (d) => d.value !== "reserved",
            message: "reserved value",
          }),
        ],
      },
    ) {}
    class Holder extends Entity("Holder")({ leaves: z.array(Leaf) }) {}
    class Root extends Entity("Root")({ holder: Holder }) {}
    // WHEN the leaf violates its own rule
    const made = Root.make({ holder: { leaves: [{ value: "reserved" }] } });
    // THEN validation reports the rule at the precise nested member
    expect(made).toBeErrWith(
      expect.objectContaining({
        entity: "Root",
        issues: [
          expect.objectContaining({
            path: ["holder", "leaves", 0],
            params: { code: "RESERVED" },
            message: "reserved value",
          }),
        ],
      }),
    );
  });

  test.each(["make", "parseCreate"] as const)(
    "%s keeps a nested invariant defect's original cause",
    (operation) => {
      // GIVEN a domain bug two parents below the Result boundary
      const cause = new Error("broken leaf invariant");
      class Leaf extends Entity("Leaf")(
        { value: z.string().brand("Value") },
        {
          invariants: [
            Entity.invariant({
              code: "BUG",
              ensure: () => {
                // oxlint-disable-next-line unthrown/no-throw — the predicate defect is under test
                throw cause;
              },
              message: "unreachable",
            }),
          ],
        },
      ) {}
      class Holder extends Entity("Holder")({ leaves: z.array(Leaf) }) {}
      class Root extends Entity("Root")({ holder: Holder }) {}
      // WHEN construction reaches the broken predicate
      const made = Root[operation]({ holder: { leaves: [{ value: "abc" }] } });
      // THEN it stays a defect rather than becoming an InvalidEntity issue
      expect(made).toBeDefectWith(cause);
    },
  );
});
