#!/usr/bin/env node

import { readdir, mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { minify } from "terser";
import webExt from "web-ext";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "addon");
const DIST = join(__dirname, "..", "dist", "addon");

const args = parseArgs(process.argv.slice(2), {
  string: ["manifest-version"],
  alias: { "manifest-version": "mv" },
});
const MANIFEST_VERSION = args.values["manifest-version"] || process.env.MV || "3";

const TERSER_OPTS = {
  compress: true,
  mangle: true,
  format: { comments: false },
};

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
  console.log("==> Linting addon source…");
  const lintResult = await webExt.cmd.lint({
    sourceDir: SRC,
    warningsAsErrors: true,
  }, { shouldExitProgram: false });
  const s = lintResult.summary;
  if (s.errors > 0) {
    console.error(`Lint failed: ${s.errors} errors`);
    process.exit(1);
  }
  if (s.warnings > 0) {
    console.log(`Lint passed with ${s.warnings} warnings`);
  } else {
    console.log("Lint OK");
  }

  let jsCount = 0;
  let copyCount = 0;

  for await (const srcPath of walk(SRC)) {
    const rel = relative(SRC, srcPath);
    const outPath = join(DIST, rel);
    await mkdir(dirname(outPath), { recursive: true });

    if (rel === "manifest.json") {
      continue;
    }
    const mvMatch = rel.match(/^manifest\.v(\d+)\.json$/);
    if (mvMatch) {
      if (mvMatch[1] === MANIFEST_VERSION) {
        await copyFile(srcPath, join(DIST, "manifest.json"));
        copyCount++;
      }
      continue;
    }

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

  const distRoot = join(DIST, "..");
  const suffix = MANIFEST_VERSION === "3" ? "" : `-mv${MANIFEST_VERSION}`;
  const xpiName = `webhid-addon${suffix}.xpi`;
  console.log("==> Packaging addon XPI…");
  await webExt.cmd.build({
    sourceDir: DIST,
    artifactsDir: distRoot,
    filename: xpiName,
    overwriteDest: true,
  }, { shouldExitProgram: false });
  console.log(`Created ${join(distRoot, xpiName)}`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
