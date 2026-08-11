import { describe, expect, it } from "vitest";

import { VERSION } from "./index.js";

describe("package", () => {
  it("exports a version", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
