import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  for (const [name, version] of family) {
    const pkg = join(root, "packages", name.slice("@btravstack/".length));
    const current = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as {
      version: string;
    };
    assert.equal(version, current.version, "template pins must match repository package versions");
  }
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

  const registry = spawnSync(
    "npm",
    ["view", `@btravstack/core@${manifest.dependencies["@btravstack/core"]}`, "version", "--json"],
    { cwd: work, encoding: "utf8" },
  );
  const unpublished = registry.status !== 0 && registry.stderr.includes("E404");
  assert.ok(registry.status === 0 || unpublished, registry.stderr);
  if (unpublished) {
    for (const [name] of family) {
      const pkg = join(root, "packages", name.slice("@btravstack/".length));
      const packed = JSON.parse(
        execFileSync("pnpm", ["pack", "--json", "--pack-destination", work], {
          cwd: pkg,
          encoding: "utf8",
        }),
      ) as { filename: string };
      manifest.dependencies[name] = `file:${packed.filename}`;
    }
    writeFileSync(join(work, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  run("npm", ["install", "--ignore-scripts", "--strict-peer-deps"]);
  const floor = manifest.engines.node.replace(/^>=/, "");
  const runtime = join(work, "node-runtime");
  mkdirSync(runtime);
  writeFileSync(join(runtime, "package.json"), JSON.stringify({ private: true }));
  execFileSync("pnpm", ["add", `node@runtime:${floor}`, "--config.minimum-release-age=0"], {
    cwd: runtime,
    stdio: "inherit",
  });
  const node = join(runtime, "node_modules", ".bin", "node");
  run(node, ["node_modules/typescript/bin/tsc", "--noEmit"]);
  run(node, ["node_modules/typescript/bin/tsc"]);

  // Node warnings and malformed event lines must not prevent the serving event from being read.
  const noise = `Node warning
null
{}
{
{"type":"serving"}
{"type":"serving","info":{"port":"invalid"}}
{"type":"serving","info":{"port":0}}
{"type":"serving","info":{"port":-1}}
{"type":"serving","info":{"port":70000}}
{"type":"serving","info":{"port":3.5}}
`;
  const preload = `data:text/javascript,process.stderr.write(${JSON.stringify(noise)})`;
  const child = spawn(node, ["--import", preload, "dist/main.js"], {
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
        let event: { type?: string; info?: { port?: unknown } } | null;
        try {
          event = JSON.parse(line) as typeof event;
        } catch {
          continue;
        }
        const port = event?.info?.port;
        if (
          event?.type === "serving" &&
          typeof port === "number" &&
          Number.isInteger(port) &&
          port > 0 &&
          port <= 65535
        ) {
          resolve(port);
        }
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
      `[template-check] ${unpublished ? "unpublished release tarballs" : "published packages"} install, typecheck, build, answer and drain on Node ${floor}\n`,
    );
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
