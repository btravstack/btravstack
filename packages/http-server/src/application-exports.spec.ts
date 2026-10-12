import { HealthChecks, Logger } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { OkAsync } from "unthrown";
import { describe, expect, it } from "vitest";

import { applicationExports } from "./application-exports.js";

describe("HTTP application exports", () => {
  it("exports only runtime ports without optional infrastructure", () => {
    // GIVEN
    const imports = [] as const;
    const providers = [] as const;

    // WHEN
    const ports = applicationExports(imports, providers);

    // THEN
    expect(ports.map((port) => port.portId)).toEqual(["Runtime", "HttpHandler"]);
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
    const ports = applicationExports([], providers);

    // THEN
    expect(ports.map((port) => port.portId)).toEqual([
      "Runtime",
      "HttpHandler",
      "Logger",
      "HealthChecks",
    ]);
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
    const ports = applicationExports([outer], []);

    // THEN
    expect(ports.map((port) => port.portId)).toEqual(["Runtime", "HttpHandler", "Logger"]);
  });

  it("keeps infrastructure hidden when its module does not export it", () => {
    // GIVEN
    const inner = Module("Hidden")({
      provides: [Provider(Logger)({ inject: {}, sync: () => null as never })],
    });

    // WHEN
    const ports = applicationExports([inner], []);

    // THEN
    expect(ports.map((port) => port.portId)).toEqual(["Runtime", "HttpHandler"]);
  });
});
