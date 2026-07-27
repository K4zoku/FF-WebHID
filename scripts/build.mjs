#!/usr/bin/env node
// Build script: addon/ -> dist/
// - .js files: minified via terser (JSDoc comments stripped)
// - everything else (manifest.json, html, css, locales, images...): copied as-is

import { readdir, mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { minify } from "terser";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "addon");
const DIST = join(__dirname, "..", "dist", "addon");

const TERSER_OPTS = {
  compress: true,
  mangle: true,
  format: { comments: false },
};

/** @param {string} dir */
async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

async function build() {
  let jsCount = 0;
  let copyCount = 0;

  for await (const srcPath of walk(SRC)) {
    const rel = relative(SRC, srcPath);
    const outPath = join(DIST, rel);
    await mkdir(dirname(outPath), { recursive: true });

    if (srcPath.endsWith(".js")) {
      const code = await readFile(srcPath, "utf8");
      const result = await minify(code, TERSER_OPTS);
      if (result.error) {
        throw new Error(`terser failed on ${rel}: ${result.error}`);
      }
      await writeFile(outPath, result.code ?? "", "utf8");
      jsCount++;
    } else {
      await copyFile(srcPath, outPath);
      copyCount++;
    }
  }

  console.log(`Built dist/: ${jsCount} JS files minified, ${copyCount} files copied`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
