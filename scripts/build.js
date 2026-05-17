#!/usr/bin/env node
// Build script. Produces dist/main.bundle.js (+ any code-split chunks)
// from client/js/main.js — ESM format, minified, sourcemaps off in prod.
//
// Run via `npm run build`. Vercel calls this automatically through
// `buildCommand` in vercel.json.

const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");

const outDir = path.join(__dirname, "..", "dist");
fs.mkdirSync(outDir, { recursive: true });

const isProd = process.env.NODE_ENV !== "development";

async function build() {
  const start = Date.now();
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, "..", "client", "js", "main.js")],
    bundle: true,
    format: "esm",
    // Single file. Code-splitting was emitting auxiliary chunks under
    // /dist that Vercel's @vercel/node packager didn't always include
    // → blank-page deploys. One ~180KB ESM file is well under the
    // 200KB target and avoids the packaging fragility entirely.
    splitting: false,
    minify: isProd,
    sourcemap: isProd ? false : "inline",
    target: ["es2022", "chrome108", "safari16", "firefox110"],
    outfile: path.join(outDir, "main.bundle.js"),
    metafile: true,
    legalComments: "none",
    treeShaking: true,
  });

  // Quick size report — useful for staying under the asset budget.
  const sizes = [];
  for (const [file, meta] of Object.entries(result.metafile.outputs)) {
    sizes.push({ file: path.basename(file), bytes: meta.bytes });
  }
  sizes.sort((a, b) => b.bytes - a.bytes);
  const total = sizes.reduce((s, x) => s + x.bytes, 0);
  console.log(`[build] esbuild done in ${Date.now() - start}ms`);
  console.log(`[build] total output: ${(total / 1024).toFixed(1)} KB across ${sizes.length} files`);
  for (const s of sizes.slice(0, 8)) {
    console.log(`  ${(s.bytes / 1024).toFixed(1).padStart(7)} KB  ${s.file}`);
  }
  if (sizes.length > 8) console.log(`  …and ${sizes.length - 8} more`);
  // Asset budget warning per PLAN.md (≤200 KB critical JS).
  if (total > 200 * 1024) {
    console.warn(`[build] ⚠ total JS ${(total/1024).toFixed(1)}KB exceeds 200KB target — consider code-splitting`);
  }
}

build().catch((err) => {
  console.error("[build] failed:", err);
  process.exit(1);
});
