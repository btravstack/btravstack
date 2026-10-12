import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

describe("template release pins", () => {
  for (const [bump, expected] of [
    ["patch", "0.29.1"],
    ["minor", "0.30.0"],
  ]) {
    it(`should follow a ${bump} release without changing third-party pins`, (test) => {
      // GIVEN
      const root = fileURLToPath(new URL("../", import.meta.url));
      const work = mkdtempSync(join(tmpdir(), "btravstack-version-"));
      test.after(() => rmSync(work, { recursive: true, force: true }));
      cpSync(join(root, "package.json"), join(work, "package.json"));
      cpSync(join(root, "pnpm-workspace.yaml"), join(work, "pnpm-workspace.yaml"));
      cpSync(join(root, ".changeset"), join(work, ".changeset"), { recursive: true });
      for (const name of readdirSync(join(work, ".changeset"))) {
        if (name.endsWith(".md") && !["AGENTS.md", "README.md"].includes(name)) {
          rmSync(join(work, ".changeset", name));
        }
      }
      for (const folder of ["packages", "examples", "internal", "docs"]) {
        cpSync(join(root, folder), join(work, folder), {
          recursive: true,
          filter: (source) =>
            !source.includes("node_modules") &&
            (source.endsWith("package.json") || statSync(source).isDirectory()),
        });
      }
      for (const name of readdirSync(join(work, "packages"))) {
        const path = join(work, "packages", name, "package.json");
        const manifest = JSON.parse(readFileSync(path, "utf8"));
        manifest.version = "0.29.0";
        writeFileSync(path, JSON.stringify(manifest));
      }
      mkdirSync(join(work, "templates", "http-app"), { recursive: true });
      const original = JSON.parse(
        readFileSync(join(root, "templates", "http-app", "package.json"), "utf8"),
      );
      writeFileSync(join(work, "templates", "http-app", "package.json"), JSON.stringify(original));
      writeFileSync(
        join(work, ".changeset", "release.md"),
        `---\n"@btravstack/core": ${bump}\n---\n\nTest release.\n`,
      );

      // WHEN
      execFileSync(
        "sh",
        ["-c", JSON.parse(readFileSync(join(work, "package.json"), "utf8")).scripts.version],
        {
          cwd: work,
          stdio: "pipe",
          env: {
            ...process.env,
            PATH: `${join(root, "node_modules", ".bin")}${delimiter}${process.env.PATH}`,
          },
        },
      );

      // THEN
      const template = JSON.parse(
        readFileSync(join(work, "templates", "http-app", "package.json"), "utf8"),
      );
      assert.deepEqual(
        template.dependencies,
        Object.fromEntries(
          Object.entries(original.dependencies).map(([name, version]) => [
            name,
            name.startsWith("@btravstack/") ? expected : version,
          ]),
        ),
      );
    });
  }
  it("should reject template pins older than the repository before installing", (test) => {
    // GIVEN
    const root = fileURLToPath(new URL("../", import.meta.url));
    const work = mkdtempSync(join(tmpdir(), "btravstack-template-drift-"));
    test.after(() => rmSync(work, { recursive: true, force: true }));
    const script = join(work, "internal", "consumer-check", "src", "check-template.ts");
    mkdirSync(join(work, "internal", "consumer-check", "src"), { recursive: true });
    cpSync(join(root, "internal", "consumer-check", "src", "check-template.ts"), script);
    cpSync(join(root, "templates"), join(work, "templates"), { recursive: true });
    cpSync(join(root, "packages"), join(work, "packages"), {
      recursive: true,
      filter: (source) =>
        !source.includes("node_modules") &&
        (source.endsWith("package.json") || statSync(source).isDirectory()),
    });
    const templatePath = join(work, "templates", "http-app", "package.json");
    const manifest = JSON.parse(readFileSync(templatePath, "utf8"));
    for (const name of Object.keys(manifest.dependencies)) {
      if (name.startsWith("@btravstack/")) manifest.dependencies[name] = "0.0.0";
    }
    writeFileSync(templatePath, JSON.stringify(manifest));
    mkdirSync(join(work, "bin"));
    writeFileSync(
      join(work, "bin", "npm"),
      "#!/bin/sh\necho 'unexpected registry call' >&2\nexit 1\n",
      { mode: 0o755 },
    );

    // WHEN
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(work, "bin")}${delimiter}${process.env.PATH}` },
    });

    // THEN
    assert.match(result.stderr, /template pins must match repository package versions/);
  });
});
