import { defineConfig } from "tsdown";

// Bundles the entry plus chatter-core (a devDependency). kysely stays external.
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  dts: false,
  clean: true,
});
