import { defineConfig } from "tsdown";

// Bundles the entry plus chatter-core (a devDependency, so tsdown inlines it).
// Runtime dependencies (@modelcontextprotocol/sdk, kysely, zod) stay external.
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  dts: false,
  clean: true,
});
