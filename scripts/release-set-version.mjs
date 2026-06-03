// Set the release version in every publishable package.json. Used by
// semantic-release (via @semantic-release/exec prepareCmd) instead of
// `npm version`, which crashes reifying bun's node_modules layout.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version) {
  process.stderr.write("usage: release-set-version <version>\n");
  process.exit(1);
}

for (const path of ["packages/mcp/package.json", "packages/cli/package.json"]) {
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.version = version;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  process.stdout.write(`set ${path} -> ${version}\n`);
}
