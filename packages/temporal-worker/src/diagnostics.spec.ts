import { createLogger, diagnosticPolicy, jsonSink } from "@btravstack/observability";
import { Runtime } from "@temporalio/worker";
import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { installTemporalDiagnostics, temporalDiagnosticLogger } from "./diagnostics.js";

describe("Temporal diagnostic disclosure", () => {
  it("filters SDK messages and metadata at every severity before logging", () => {
    // Arrange
    const written: string[] = [];
    const diagnostics = diagnosticPolicy({
      messages: ["safe"],
      fields: { sdkComponent: ["activity", "core"] },
    });
    const logger = temporalDiagnosticLogger(
      createLogger(jsonSink({ write: (line) => written.push(line) }), "trace"),
      diagnostics,
    );
    const metadata = {
      sdkComponent: "activity",
      error: new Error("nested@example.invalid"),
      attached: "attached@example.invalid",
    };
    // Act
    logger.log("TRACE", "safe", metadata);
    logger.trace("top@example.invalid", metadata);
    logger.debug("top@example.invalid", metadata);
    logger.info("top@example.invalid", metadata);
    logger.warn("top@example.invalid", metadata);
    logger.error("top@example.invalid", metadata);
    // Assert
    expect({
      leaked: written.join("").includes("@example.invalid"),
      lines: written.map((line) => JSON.parse(line) as unknown),
    }).toEqual({
      leaked: false,
      lines: ["safe", "diagnostic", "diagnostic", "diagnostic", "diagnostic", "diagnostic"].map(
        (message) => expect.objectContaining({ message, sdkComponent: "activity" }),
      ),
    });
  });

  it("protects actual activity failures and native runtime diagnostics without changing outcomes", async ({
    serveObserved,
  }) => {
    // Arrange
    const written: string[] = [];
    const diagnostics = diagnosticPolicy({
      fields: { sdkComponent: ["activity", "worker", "workflow", "core"] },
    });
    const logger = createLogger(jsonSink({ write: (line) => written.push(line) }), "trace");
    const installed = installTemporalDiagnostics({ logger, diagnostics, nativeLogLevel: "TRACE" });
    const cause = new Error("activity@example.invalid", {
      cause: new Error("nested@example.invalid"),
    });
    Object.assign(cause, { attached: "payload@example.invalid" });
    // Act
    const { app, client, taskQueue, taken } = await serveObserved(true, undefined, cause);
    const failed = await client.workflow
      .execute("runEcho", { taskQueue, workflowId: "diagnostic-failure", args: ["x"] })
      .then(
        () => false,
        () => true,
      );
    const runtime = Runtime.instance();
    runtime.logger.error("sdk@example.invalid", { error: cause });
    runtime.flushLogs();
    await vi.waitUntil(() => written.some((line) => line.includes('"sdkComponent":"core"')));
    const late = installTemporalDiagnostics({ logger, diagnostics });
    app.stop();
    await app.exited;
    // Assert
    expect({
      installed: installed.tag,
      failed,
      taken: taken(),
      late: late.tag,
      leaked: written.join("").includes("@example.invalid"),
      worker: written.some((line) => line.includes('"sdkComponent":"worker"')),
      native: written.some((line) => line.includes('"sdkComponent":"core"')),
    }).toEqual({
      installed: "Ok",
      failed: true,
      taken: [expect.objectContaining({ outcome: "error" })],
      late: "Defect",
      leaked: false,
      worker: true,
      native: true,
    });
  });
});
