import { Module, Port, Provider } from "@btravstack/di";
import { OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { HealthChecks } from "./health.js";
import { infrastructureExports } from "./infrastructure-exports.js";
import { Logger } from "./observability.js";

describe("application infrastructure exports", () => {
  it("exports nothing without optional infrastructure", () => {
    // GIVEN
    const imports = [] as const;
    const providers = [] as const;

    // WHEN
    const ports = infrastructureExports(imports, providers);

    // THEN
    expect(ports).toEqual([]);
  });

  it("exports infrastructure provided at the application root", () => {
    // GIVEN
    const providers = [
      Provider(Logger)({ inject: {}, sync: () => null as never }),
      Provider.member(HealthChecks)({
        inject: {},
        value: { name: "backend", timeoutMs: 100, check: () => OkAsync() },
      }),
    ];

    // WHEN
    const ports = infrastructureExports([], providers);

    // THEN
    expect(ports.map((port) => port.portId)).toEqual(["Logger", "HealthChecks"]);
  });

  it("follows module re-exports without exposing business ports", () => {
    // GIVEN
    const Business = Port("Business")<string>;
    const inner = Module("Inner")({
      provides: [
        Provider(Logger)({ inject: {}, sync: () => null as never }),
        Provider(Business)({ inject: {}, value: "private" }),
      ],
      exports: [Logger, Business],
    });
    const outer = Module("Outer")({ imports: [inner], exports: [inner] });

    // WHEN
    const ports = infrastructureExports([outer], []);

    // THEN
    expect(ports.map((port) => port.portId)).toEqual(["Logger"]);
  });

  it("keeps infrastructure hidden when its module does not export it", () => {
    // GIVEN
    const inner = Module("Hidden")({
      provides: [Provider(Logger)({ inject: {}, sync: () => null as never })],
    });

    // WHEN
    const ports = infrastructureExports([inner], []);

    // THEN
    expect(ports).toEqual([]);
  });
});
