import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const removeEmptyChangesets = (directory) => {
  const removed = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (["AGENTS.md", "README.md", "CLAUDE.md", "GEMINI.md"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (!/^---\r?\n[\t \r\n]*---(?:\r?\n|$)/.test(readFileSync(path, "utf8"))) continue;
    unlinkSync(path);
    removed.push(entry.name);
  }
  return removed.sort();
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const removed = removeEmptyChangesets(".changeset");
  console.log(`Removed empty changesets: ${removed.join(", ") || "none"}`);
}
