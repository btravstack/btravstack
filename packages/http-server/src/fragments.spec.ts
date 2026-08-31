import { describe, expect, it } from "vitest";

import { matchPath } from "./fragments.js";

describe("matchPath", () => {
  it("binds every named segment of a matching path", () => {
    // GIVEN a pattern with two parameters
    // WHEN a path of the same shape is matched
    const bound = matchPath("/tenants/:tenant/orders/:id", "/tenants/acme/orders/42");

    // THEN both are bound, by name
    expect(bound).toEqual({ tenant: "acme", id: "42" });
  });

  it("declines a path whose segment count differs", () => {
    // GIVEN a pattern of three segments
    // WHEN a longer path is matched
    const bound = matchPath("/orders/:id/row", "/orders/42/row/extra");

    // THEN it does not match: a mount is a shape, not a prefix
    expect(bound).toBeUndefined();
  });

  it("declines a path whose literal segment differs", () => {
    // GIVEN a pattern whose last segment is a literal
    // WHEN a path differing only there is matched
    const bound = matchPath("/orders/:id/row", "/orders/42/cell");

    // THEN it does not match
    expect(bound).toBeUndefined();
  });

  it("binds nothing for a pattern with no parameters", () => {
    // GIVEN a wholly literal pattern
    // WHEN its exact path is matched
    const bound = matchPath("/orders", "/orders");

    // THEN it matches with an empty binding, which is not the same as no match
    expect(bound).toEqual({});
  });

  it("matches the literal root against itself", () => {
    // GIVEN the root pattern
    // WHEN the root path is matched
    const bound = matchPath("/", "/");

    // THEN it matches with an empty binding
    expect(bound).toEqual({});
  });

  it("declines a parameter segment that is not validly percent-encoded", () => {
    // GIVEN a pattern with one parameter
    // WHEN the path's segment is a malformed percent-encoding
    const bound = matchPath("/orders/:id", "/orders/%ZZ");

    // THEN it declines the match instead of throwing
    expect(bound).toBeUndefined();
  });

  it("declines a trailing slash that would bind an empty parameter", () => {
    // GIVEN a pattern with one parameter
    // WHEN the path ends where the parameter should start
    const bound = matchPath("/orders/:id", "/orders/");

    // THEN it does not match: an empty value is not a bound id
    expect(bound).toBeUndefined();
  });
});
