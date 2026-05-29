import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/index.js",
  // Keep dependencies external; esbuild only compiles/bundles our own sources.
  packages: "external",
  sourcemap: true,
  logLevel: "info",
});
