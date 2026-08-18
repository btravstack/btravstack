import { describe, expect } from "vitest";

import { isAuthenticated } from "./auth.js";
import { it } from "./test-fixtures.js";

describe("authenticated", () => {
  it("marks the node it is given", ({ authenticated, fragment }) => {
    // GIVEN an unmarked contract fragment
    // WHEN it is marked
    const marked = authenticated(fragment);
    // THEN the marker is readable, and the value came back unchanged
    expect({ marked: isAuthenticated(marked), same: marked === fragment }).toEqual({
      marked: true,
      same: true,
    });
  });

  it("adds no enumerable key", ({ authenticated, fragment }) => {
    // GIVEN a fragment with exactly one key
    // WHEN it is marked
    const marked = authenticated(fragment);
    // THEN nothing was added for `implement()` to walk as a procedure
    expect(Reflect.ownKeys(marked)).toEqual(["place"]);
  });

  it("leaves an unmarked node unmarked", ({ fragment }) => {
    // GIVEN a fragment nobody marked
    // WHEN it is asked
    // THEN it is not authenticated
    expect(isAuthenticated(fragment)).toBe(false);
  });

  it("keeps two contracts' markers independent", ({ authenticated, fragment }) => {
    // GIVEN two nodes, one marked
    const other = { find: { kind: "procedure" } as const };
    // WHEN only the first is marked
    authenticated(fragment);
    // THEN the second is untouched
    expect({ first: isAuthenticated(fragment), second: isAuthenticated(other) }).toEqual({
      first: true,
      second: false,
    });
  });
});
