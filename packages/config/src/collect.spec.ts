import { Module } from "@btravstack/di";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { collect } from "./collect.js";
import { Config } from "./slice.js";

const aShape = { x: z.string().default("a") };
const A = Config("A")(aShape, { prefix: "A" });

const bShape = { y: z.string().default("b") };
const B = Config("B")(bShape, { prefix: "B" });

describe("collect", () => {
  it("finds an adapter nested anywhere in the import tree", () => {
    // GIVEN an adapter imported by a module imported by the root
    const Inner = Module("Inner")({ imports: [A], exports: [A] });
    const Root = Module("Root")({ imports: [Inner, B], exports: [A, B] });

    // WHEN the tree is walked
    // THEN both adapters are found, wherever they sit
    expect(collect(Root)).toEqual(expect.arrayContaining([A, B]));
  });

  it("returns an adapter imported twice only once", () => {
    // GIVEN two modules importing the same adapter
    const One = Module("One")({ imports: [A], exports: [A] });
    const Two = Module("Two")({ imports: [A], exports: [A] });
    const Root = Module("Root")({ imports: [One, Two], exports: [A] });

    // WHEN the tree is walked
    // THEN the adapter appears once — it is parsed once, so it is reported once
    expect(collect(Root)).toEqual([A]);
  });

  it("returns adapters in the order they were declared", () => {
    // GIVEN a root importing two adapters directly, in a given order
    const Root = Module("Root")({ imports: [A, B], exports: [A, B] });

    // WHEN the tree is walked
    // THEN they come back in that same order — `describeIssues` promises one
    // line per issue "in the order the adapters declared them"
    expect(collect(Root)).toEqual([A, B]);
  });

  it("ignores ordinary modules", () => {
    // GIVEN a tree with no adapters at all
    const Plain = Module("Plain")({});
    const Root = Module("Root")({ imports: [Plain] });

    // WHEN the tree is walked
    // THEN nothing is reported
    expect(collect(Root)).toEqual([]);
  });
});
