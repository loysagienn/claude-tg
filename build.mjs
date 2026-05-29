import { context } from "esbuild";

const options = {
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
};

const watch = process.argv.includes("--watch");
const ctx = await context(options);

if (watch) {
  // Debounce rebuilds by 5s so bursts of file changes trigger a single build.
  await ctx.watch({ delay: 5000 });
  console.log("esbuild: watching for changes (5s debounce)...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
