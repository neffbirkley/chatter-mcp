import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

// chatter-core is a build input (bundled in), not a runtime dependency, so it's
// resolved by alias here + tsconfig `paths`, not declared as a package dep.
// Runtime deps (@modelcontextprotocol/sdk, kysely, zod) stay external.
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  dts: false,
  clean: true,
  alias: {
    "chatter-core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
  },
});
