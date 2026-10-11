import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "btravstack-template-"));

const run = (command: string, args: readonly string[]) =>
  execFileSync(command, [...args], { cwd: work, stdio: "inherit" });

try {
  cpSync(join(root, "templates", "http-app"), work, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(work, "package.json"), "utf8")) as {
    engines: { node: string };
    dependencies: Record<string, string>;
  };
  const family = Object.entries(manifest.dependencies).filter(([name]) =>
    name.startsWith("@btravstack/"),
  );
  assert.equal(
    new Set(family.map(([, version]) => version)).size,
    1,
    "framework packages upgrade together",
  );
  const orpc = Object.entries(manifest.dependencies).filter(([name]) => name.startsWith("@orpc/"));
  assert.equal(
    new Set(orpc.map(([, version]) => version)).size,
    1,
    "oRPC beta peers upgrade together",
  );
  for (const [, version] of Object.entries(manifest.dependencies)) {
    assert.match(
      version,
      /^\d+\.\d+\.\d+(?:-[\w.]+)?$/,
      "template dependencies are exact published versions",
    );
  }

  run("npm", ["install", "--ignore-scripts", "--strict-peer-deps"]);
  const floor = manifest.engines.node.replace(/^>=/, "");
  run("pnpm", ["add", `node@runtime:${floor}`, "--config.minimum-release-age=0"]);
  const node = join(work, "node_modules", ".bin", "node");
  run(node, ["node_modules/typescript/bin/tsc", "--noEmit"]);
  run(node, ["node_modules/typescript/bin/tsc"]);

  const child = spawn(node, ["dist/main.js"], {
    cwd: work,
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      PROBE_PORT: "0",
      PROBE_HOST: "127.0.0.1",
      PRE_DRAIN_DELAY_MS: "0",
      DRAIN_TIMEOUT_MS: "1000",
      STOP_TIMEOUT_MS: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
    signal: AbortSignal.timeout(15_000),
  });
  let stderr = "";
  let pending = "";
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const ready = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`template exited before serving: ${stderr}`)));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) {
        const event = JSON.parse(line) as { type: string; info?: { port: number } };
        if (event.type === "serving") resolve(event.info!.port);
      }
    });
  });
  try {
    const port = await ready;
    const response = await fetch(`http://127.0.0.1:${port}/rpc/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { name: "world" } }),
    });
    assert.deepEqual(
      { status: response.status, body: await response.json() },
      {
        status: 200,
        body: { json: { message: "Hello, world!" } },
      },
    );
    child.kill("SIGTERM");
    assert.equal(await exited, 0, stderr);
    assert.match(stderr, /"type":"drained"/);
    assert.match(stderr, /"type":"exited"/);
    process.stdout.write(
      `[template-check] published packages install, typecheck, build, answer and drain on Node ${floor}\n`,
    );
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
