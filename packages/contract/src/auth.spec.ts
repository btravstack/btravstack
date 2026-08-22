import { describe, expect } from "vitest";

import { authenticated, isAuthenticated } from "./auth.js";
import { it } from "./test-fixtures.js";

describe("authenticated", () => {
  it("returns the requirements it was marked with", ({ fragment }) => {
    // GIVEN an unmarked contract fragment
    // WHEN it is marked with one requirement
    const marked = authenticated({ user: [] })(fragment);
    // THEN the requirements are readable, and the value came back unchanged
    expect({ requirements: isAuthenticated(marked), same: marked === fragment }).toEqual({
      requirements: [{ user: [] }],
      same: true,
    });
  });

  it("keeps every requirement, in the order given", ({ fragment }) => {
    // GIVEN a fragment
    // WHEN it is marked with two requirements and a scope
    authenticated({ user: ["orders:export"] }, { service: [] })(fragment);
    // THEN both survive, in order — the runtime tries them in this order
    expect(isAuthenticated(fragment)).toEqual([{ user: ["orders:export"] }, { service: [] }]);
  });

  it("adds no enumerable key", ({ fragment }) => {
    // GIVEN a fragment with exactly one key
    // WHEN it is marked
    authenticated({ user: [] })(fragment);
    // THEN nothing was added for `implement()` to walk as a procedure
    expect(Reflect.ownKeys(fragment)).toEqual(["place"]);
  });

  it("answers undefined for a node nobody marked", ({ fragment }) => {
    // GIVEN a fragment nobody marked
    // WHEN it is asked
    // THEN it is not authenticated — `undefined`, not an empty list, so a
    // caller cannot confuse "public" with "protected by nothing"
    expect(isAuthenticated(fragment)).toBeUndefined();
  });

  it("registers the mark where a second copy of this package would find it", ({ fragment }) => {
    // GIVEN the registry as any other copy of this package would reach it
    const registry = (globalThis as Record<symbol, Map<object, unknown> | undefined>)[
      Symbol.for("@btravstack/contract/requirements")
    ];
    // WHEN a node is marked
    authenticated({ user: [] })(fragment);
    // THEN that shared registry is the one holding it — a module-private map
    // here would read unmarked to a second copy, and serve the route open.
    expect({ registered: registry !== undefined, holds: registry?.get(fragment) }).toEqual({
      registered: true,
      holds: [{ user: [] }],
    });
  });
});
