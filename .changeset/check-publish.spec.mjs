import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

describe("release registry preflight", () => {
  for (const [scenario, name, expected] of [
    [
      "existing",
      "should publish after checking every package",
      {
        status: 0,
        calls: [
          "npm @btravstack/first",
          "npm @btravstack/second",
          "pnpm build",
          "changeset publish",
        ],
        diagnostic: false,
      },
    ],
    [
      "missing",
      "should stop before publication when a package is missing from the registry",
      { status: 1, calls: ["npm @btravstack/first", "npm @btravstack/second"], diagnostic: true },
    ],
    [
      "unavailable",
      "should stop before publication when the registry is unavailable",
      { status: 1, calls: ["npm @btravstack/first"], diagnostic: false },
    ],
  ]) {
    it(name, (test) => {
      // GIVEN
      const root = fileURLToPath(new URL("../", import.meta.url));
      const work = mkdtempSync(join(tmpdir(), "btravstack-publish-"));
      test.after(() => rmSync(work, { recursive: true, force: true }));
      mkdirSync(join(work, ".changeset"));
      cpSync(
        join(root, ".changeset", "check-publish.mjs"),
        join(work, ".changeset", "check-publish.mjs"),
      );
      writeFileSync(
        join(work, ".changeset", "config.json"),
        JSON.stringify({ fixed: [["@btravstack/first", "@btravstack/second"]] }),
      );
      mkdirSync(join(work, "bin"));
      writeFileSync(join(work, "calls"), "");
      writeFileSync(
        join(work, "bin", "npm"),
        `#!/bin/sh\necho "npm $2" >> calls\n${scenario === "unavailable" ? "echo E503 >&2\nexit 1" : scenario === "missing" ? 'if [ "$2" = "@btravstack/second" ]; then echo \'{"error":{"code":"E404"}}\'; exit 1; fi' : "exit 0"}\n`,
        { mode: 0o755 },
      );
      for (const command of ["pnpm", "changeset"]) {
        writeFileSync(join(work, "bin", command), `#!/bin/sh\necho "${command} $*" >> calls\n`, {
          mode: 0o755,
        });
      }
      const release = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts.release;
      // WHEN
      const result = spawnSync("sh", ["-c", release], {
        cwd: work,
        encoding: "utf8",
        env: { ...process.env, PATH: `${join(work, "bin")}${delimiter}${process.env.PATH}` },
      });
      // THEN
      assert.deepEqual(
        {
          status: result.status,
          calls: readFileSync(join(work, "calls"), "utf8").trim().split("\n"),
          diagnostic: /Trusted Publisher/.test(result.stderr),
        },
        expected,
      );
    });
  }
});
