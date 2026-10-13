import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { removeEmptyChangesets } from "./remove-empty.mjs";

describe("release preparation", () => {
  it("removes empty changesets while preserving named releases and guidance", (test) => {
    // GIVEN
    const work = mkdtempSync(join(tmpdir(), "btravstack-changesets-"));
    test.after(() => rmSync(work, { recursive: true, force: true }));
    const named = '---\n"@btravstack/outbox": minor\n---\n\nShip the relay.\n';
    writeFileSync(join(work, "release.md"), named);
    writeFileSync(join(work, "docs.md"), "---\n---\n\nDocumentation only.\n");
    writeFileSync(join(work, "windows.md"), "---\r\n \t\r\n---\r\n\r\nDocumentation only.\r\n");
    writeFileSync(join(work, "AGENTS.md"), "---\n---\n\nRelease guidance.\n");
    writeFileSync(join(work, "README.md"), "Readme.\n");
    writeFileSync(join(work, "config.json"), "{}\n");
    // WHEN
    const removed = removeEmptyChangesets(work);
    // THEN
    assert.deepEqual(
      {
        removed,
        remaining: readdirSync(work).sort(),
        named: readFileSync(join(work, "release.md"), "utf8"),
      },
      {
        removed: ["docs.md", "windows.md"],
        remaining: ["AGENTS.md", "README.md", "config.json", "release.md"],
        named,
      },
    );
  });

  it("prepares an empty-only checkout without changing its version", (test) => {
    // GIVEN
    const work = mkdtempSync(join(tmpdir(), "btravstack-changesets-"));
    test.after(() => rmSync(work, { recursive: true, force: true }));
    const changesets = join(work, ".changeset");
    mkdirSync(changesets);
    writeFileSync(join(changesets, "docs.md"), "---\n---\n\nNo release.\n");
    const manifest = '{"version":"0.34.0"}\n';
    writeFileSync(join(work, "package.json"), manifest);
    const script = fileURLToPath(new URL("./remove-empty.mjs", import.meta.url));
    // WHEN
    const first = execFileSync(process.execPath, [script], { cwd: work, encoding: "utf8" });
    const second = execFileSync(process.execPath, [script], { cwd: work, encoding: "utf8" });
    // THEN
    assert.deepEqual(
      {
        remaining: readdirSync(changesets),
        first,
        second,
        manifest: readFileSync(join(work, "package.json"), "utf8"),
      },
      {
        remaining: [],
        first: "Removed empty changesets: docs.md\n",
        second: "Removed empty changesets: none\n",
        manifest,
      },
    );
  });
});
