import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const { fixed } = JSON.parse(readFileSync(".changeset/config.json", "utf8"));
const missing = [];
for (const name of new Set(fixed.flat())) {
  const result = spawnSync("npm", ["view", name, "name", "--json"], { encoding: "utf8" });
  if (result.status === 0) continue;
  const diagnostic = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (/\bE404\b/u.test(diagnostic)) {
    missing.push(name);
    continue;
  }
  console.error(`Registry preflight failed for ${name}: ${result.error?.message ?? diagnostic}`);
  process.exit(1);
}
if (missing.length > 0) {
  console.error(
    `Packages are not readable on the configured npm registry: ${missing.join(", ")}. Check registry access; for a new package, publish its initial version and configure its npm Trusted Publisher before retrying the release. No packages were published.`,
  );
  process.exit(1);
}
