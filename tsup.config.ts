import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts", runtime: "src/runtime/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "es2022",
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["cjs"],
    banner: { js: "#!/usr/bin/env node" },
    target: "es2022",
  },
]);
