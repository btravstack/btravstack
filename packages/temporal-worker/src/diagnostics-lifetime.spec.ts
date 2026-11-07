import { Runtime } from "@temporalio/worker";
import { Err, Ok, OkAsync, fromSafePromise } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { installTemporalDiagnostics, withTemporalDiagnostics } from "./diagnostics.js";

describe("scoped Temporal diagnostics lifetime", () => {
  it("exits naturally after a modeled acquisition refusal and releases its earlier resource", async ({
    diagnosticsProcess,
  }) => {
    // GIVEN
    const mode = "refusal";
    // WHEN
    const result = await diagnosticsProcess(mode);
    // THEN
    expect(result).toBeOkWith({
      exitCode: 0,
      signal: null,
      timedOut: false,
      snapshot: {
        outcome: { tag: "Err", code: "SyntheticCredentialsUnavailable" },
        released: 1,
        sockets: 0,
        runtimeAbsent: true,
        defaultsRestored: true,
      },
      stderr: "",
    });
  });

  it("exits naturally after an acquisition defect and releases its earlier resource", async ({
    diagnosticsProcess,
  }) => {
    // GIVEN
    const mode = "defect";
    // WHEN
    const result = await diagnosticsProcess(mode);
    // THEN
    expect(result).toBeOkWith({
      exitCode: 0,
      signal: null,
      timedOut: false,
      snapshot: {
        outcome: { tag: "Defect", sameCause: true },
        released: 1,
        sockets: 0,
        runtimeAbsent: true,
        defaultsRestored: true,
      },
      stderr: "",
    });
  });

  it("exits naturally after a synchronous startup callback defect", async ({
    diagnosticsProcess,
  }) => {
    // GIVEN
    const mode = "sync-defect";
    // WHEN
    const result = await diagnosticsProcess(mode);
    // THEN
    expect(result).toBeOkWith({
      exitCode: 0,
      signal: null,
      timedOut: false,
      snapshot: {
        outcome: { tag: "Defect", sameCause: true },
        released: 0,
        sockets: 0,
        runtimeAbsent: true,
        defaultsRestored: true,
      },
      stderr: "",
    });
  });

  it("leaves no runtime behind when startup succeeds without needing a connection", async ({
    diagnosticsProcess,
  }) => {
    // GIVEN
    const mode = "success";
    // WHEN
    const result = await diagnosticsProcess(mode);
    // THEN
    expect(result).toBeOkWith({
      exitCode: 0,
      signal: null,
      timedOut: false,
      snapshot: {
        outcome: { tag: "Ok", value: "served" },
        released: 1,
        sockets: 0,
        runtimeAbsent: true,
        defaultsRestored: true,
      },
      stderr: "",
    });
  });

  it("restores the caller's defaults and preserves a synchronous success", async ({
    diagnostics,
  }) => {
    // GIVEN
    const { options, previousDefaults } = diagnostics;
    // WHEN
    const result = await withTemporalDiagnostics(options, () => Ok("served"));
    // THEN
    expect({
      result,
      restored: Runtime.defaultOptions === previousDefaults,
      runtime: Runtime._instance,
    }).toEqual({
      result: Ok("served"),
      restored: true,
      runtime: undefined,
    });
  });

  it("restores the caller's defaults and preserves the exact modeled refusal", async ({
    diagnostics,
  }) => {
    // GIVEN
    const failure = { kind: "synthetic-refusal" } as const;
    // WHEN
    const result = await withTemporalDiagnostics(diagnostics.options, () => Err(failure));
    // THEN
    expect({
      result,
      sameFailure: result.isErr() && result.error === failure,
      restored: Runtime.defaultOptions === diagnostics.previousDefaults,
    }).toEqual({
      result: Err(failure),
      sameFailure: true,
      restored: true,
    });
  });

  it("restores the caller's defaults after a synchronous callback defect", async ({
    diagnostics,
  }) => {
    // GIVEN
    const cause = new Error("synthetic startup defect");
    // WHEN
    const result = await withTemporalDiagnostics(diagnostics.options, () => {
      // oxlint-disable-next-line unthrown/no-throw -- the subject is a synchronous callback defect before any native connection
      throw cause;
    });
    // THEN
    expect({
      sameCause: result.isDefect() && result.cause === cause,
      restored: Runtime.defaultOptions === diagnostics.previousDefaults,
    }).toEqual({ sameCause: true, restored: true });
  });

  it("preserves a configuration replaced by its caller during the scope", async ({
    diagnostics,
  }) => {
    // GIVEN
    const replacement = { shutdownSignals: [] };
    // WHEN
    const result = await withTemporalDiagnostics(diagnostics.options, () => {
      Runtime.defaultOptions = replacement;
      return Ok("served");
    });
    // THEN
    expect({ result, replacementRetained: Runtime.defaultOptions === replacement }).toEqual({
      result: Ok("served"),
      replacementRetained: true,
    });
  });

  it("refuses overlapping scopes without invoking the nested startup callback", async ({
    diagnostics,
  }) => {
    // GIVEN
    let invoked = false;
    // WHEN
    const result = await withTemporalDiagnostics(diagnostics.options, () =>
      withTemporalDiagnostics(diagnostics.options, () => {
        invoked = true;
        return Ok();
      }),
    );
    // THEN
    expect({
      tag: result.tag,
      invoked,
      restored: Runtime.defaultOptions === diagnostics.previousDefaults,
      runtime: Runtime._instance,
    }).toEqual({ tag: "Defect", invoked: false, restored: true, runtime: undefined });
  });

  it("refuses eager installation inside the scope without creating a native runtime", async ({
    diagnostics,
  }) => {
    // GIVEN
    const { options } = diagnostics;
    // WHEN
    const result = await withTemporalDiagnostics(options, () =>
      installTemporalDiagnostics(options),
    );
    // THEN
    expect({
      tag: result.tag,
      restored: Runtime.defaultOptions === diagnostics.previousDefaults,
      runtime: Runtime._instance,
    }).toEqual({ tag: "Defect", restored: true, runtime: undefined });
  });

  it("preserves an active caller-owned runtime and its usable connection", async ({
    diagnostics,
    nativeConnections,
    server,
  }) => {
    // GIVEN
    const connection = (await nativeConnections.open()).get();
    const runtime = Runtime.instance();
    const defaults = Runtime.defaultOptions;
    let invoked = false;
    // WHEN
    const result = await withTemporalDiagnostics(diagnostics.options, () => {
      invoked = true;
      return Ok();
    });
    const response = await connection.workflowService.describeNamespace({
      namespace: server.namespace,
    });
    // THEN
    expect({
      tag: result.tag,
      invoked,
      sameRuntime: Runtime._instance === runtime,
      sameLogger: Runtime._instance?.logger === runtime.logger,
      sameDefaults: Runtime.defaultOptions === defaults,
      namespace: response.namespaceInfo?.name,
    }).toEqual({
      tag: "Defect",
      invoked: false,
      sameRuntime: true,
      sameLogger: true,
      sameDefaults: true,
      namespace: server.namespace,
    });
  });

  it("leaves an active connection usable after the callback returns", async ({
    diagnostics,
    nativeConnections,
    server,
  }) => {
    // GIVEN
    const { options, previousDefaults } = diagnostics;
    // WHEN
    const connection = (
      await withTemporalDiagnostics(options, () => nativeConnections.open())
    ).get();
    const response = await connection.workflowService.describeNamespace({
      namespace: server.namespace,
    });
    // THEN
    expect({
      active: Runtime._instance !== undefined,
      restored: Runtime.defaultOptions === previousDefaults,
      namespace: response.namespaceInfo?.name,
    }).toEqual({ active: true, restored: true, namespace: server.namespace });
  });

  it("lets the SDK close its native runtime while preserving protected SDK logs", async ({
    diagnostics,
    nativeConnections,
    server,
  }) => {
    // GIVEN
    const { options, written, previousDefaults } = diagnostics;
    // WHEN
    const result = await withTemporalDiagnostics(options, () =>
      nativeConnections
        .open()
        .flatTap((connection) =>
          fromSafePromise(
            connection.workflowService.describeNamespace({ namespace: server.namespace }),
          ),
        )
        .tap(() =>
          Runtime.instance().logger.error("synthetic@example.invalid", {
            attached: "secret@example.invalid",
          }),
        )
        .flatTap(nativeConnections.close)
        .map(() => "served"),
    );
    // THEN
    expect({
      result,
      restored: Runtime.defaultOptions === previousDefaults,
      runtime: Runtime._instance,
      leaked: written.join("").includes("@example.invalid"),
      protectedMessage: written.some((line) => line.includes('"message":"diagnostic"')),
    }).toEqual({
      result: Ok("served"),
      restored: true,
      runtime: undefined,
      leaked: false,
      protectedMessage: true,
    });
  });

  it("keeps asynchronous startup defects in their original channel", async ({ diagnostics }) => {
    // GIVEN
    const cause = new Error("synthetic asynchronous startup defect");
    // WHEN
    const result = await withTemporalDiagnostics(diagnostics.options, () =>
      OkAsync().map(() => {
        // oxlint-disable-next-line unthrown/no-throw -- the subject is an asynchronous result callback defect
        throw cause;
      }),
    );
    // THEN
    expect({
      sameCause: result.isDefect() && result.cause === cause,
      restored: Runtime.defaultOptions === diagnostics.previousDefaults,
    }).toEqual({ sameCause: true, restored: true });
  });

  it("permits a fresh startup after a synchronous factory defect", async ({ diagnostics }) => {
    // GIVEN
    const cause = new Error("synthetic factory defect");
    // WHEN
    const first = await withTemporalDiagnostics(diagnostics.options, () => {
      // oxlint-disable-next-line unthrown/no-throw -- the subject is a factory defect followed by another startup
      throw cause;
    });
    const second = await withTemporalDiagnostics(diagnostics.options, () => Ok("recovered"));
    // THEN
    expect({
      sameCause: first.isDefect() && first.cause === cause,
      second,
      restored: Runtime.defaultOptions === diagnostics.previousDefaults,
    }).toEqual({ sameCause: true, second: Ok("recovered"), restored: true });
  });

  it("serves a real workflow and flushes protected diagnostics through owned worker teardown", async ({
    diagnostics,
    serveObserved,
  }) => {
    // GIVEN
    const { options, previousDefaults, written } = diagnostics;
    // WHEN
    const result = await withTemporalDiagnostics(options, () =>
      fromSafePromise(
        (async () => {
          const { app, client, taskQueue } = await serveObserved();
          const answer = await client.workflow.execute("runEcho", {
            taskQueue,
            workflowId: "scoped-diagnostics-lifetime",
            args: ["hello"],
          });
          Runtime.instance().logger.error("synthetic@example.invalid", {
            attached: "secret@example.invalid",
          });
          app.stop();
          const exit = await app.exited;
          return { answer, exited: exit.tag };
        })(),
      ),
    );
    // THEN
    expect({
      result,
      runtime: Runtime._instance,
      restored: Runtime.defaultOptions === previousDefaults,
      leaked: written.join("").includes("@example.invalid"),
      native: written.some((line) => line.includes('"sdkComponent":"core"')),
    }).toEqual({
      result: Ok({ answer: "hello", exited: "Ok" }),
      runtime: undefined,
      restored: true,
      leaked: false,
      native: true,
    });
  });
});
