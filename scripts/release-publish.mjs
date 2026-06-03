// Publish each package with `npm publish --no-workspaces` — npm's workspace
// reify (triggered without this flag) crashes on bun's node_modules layout.
// OIDC trusted publishing + provenance are handled by npm itself in CI
// (id-token + NPM_CONFIG_PROVENANCE); no token needed. `prepack` (tsdown)
// builds each dist during publish.
import { execFileSync } from "node:child_process";

for (const cwd of ["packages/mcp", "packages/cli"]) {
  process.stdout.write(`publishing ${cwd}\n`);
  execFileSync("npm", ["publish", "--no-workspaces", "--access", "public"], {
    cwd,
    stdio: "inherit",
  });
}
