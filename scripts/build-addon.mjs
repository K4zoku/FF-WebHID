#!/usr/bin/env node

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { minify } from "terser";
import webExt from "web-ext";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "addon");
const DIST = join(__dirname, "..", "dist", "addon");

const args = parseArgs({
  args: process.argv.slice(2),
  options: {
    "manifest-version": { type: "string", alias: "mv" },
  },
});
const MANIFEST_VERSION = args.values["manifest-version"] || process.env.MV || "3";

const TERSER_OPTS = {
  compress: true,
  mangle: true,
  format: { comments: false },
};

// ── collect files from manifest ──────────────────────────────────────────────

// ── HTML/CSS minification ────────────────────────────────────────────────────

function minifyCSS(code) {
  const strings = [];
  code = code.replace(/(['"])(?:\\.|(?!\1)[^\\])*?\1/g, s => {
    strings.push(s);
    return `\0STR${strings.length - 1}\0`;
  });
  code = code.replace(/\/\*[\s\S]*?\*\//g, "");           // remove comments
  code = code.replace(/\0STR(\d+)\0/g, (_, i) => strings[i]);
  code = code
    .replace(/\s*([{}:;,])\s*/g, "$1")                    // collapse whitespace around tokens
    .replace(/;\}/g, "}")                                 // remove trailing semicolons
    .trim();
  return code;
}

function minifyHTML(code) {
  return code
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")                // remove HTML comments
    .replace(/>\s+</g, "><")                              // collapse whitespace between tags
    .replace(/\s{2,}/g, " ")                              // collapse multiple whitespace
    .replace(/\s*([=])\s*/g, "$1")                        // collapse spaces around =
    .trim();
}

function collectManifestFiles(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const files = new Set();

  files.add(""); // manifest root itself

  function add(p) {
    if (p && typeof p === "string") files.add(p);
  }

  // background
  if (manifest.background) {
    if (Array.isArray(manifest.background.scripts)) {
      manifest.background.scripts.forEach(add);
    }
    add(manifest.background.service_worker);
  }

  // content_scripts
  if (Array.isArray(manifest.content_scripts)) {
    for (const cs of manifest.content_scripts) {
      if (Array.isArray(cs.js)) cs.js.forEach(add);
      if (Array.isArray(cs.css)) cs.css.forEach(add);
    }
  }

  // popup pages
  for (const key of ["page_action", "action", "browser_action"]) {
    if (manifest[key]) add(manifest[key].default_popup);
  }
  add(manifest.options_ui && manifest.options_ui.page);
  add(manifest.sidebar_action && manifest.sidebar_action.default_panel);
  add(manifest.devtools_page);

  // icons (all sizes)
  for (const obj of [manifest.icons]) {
    if (obj && typeof obj === "object") {
      for (const v of Object.values(obj)) add(v);
    }
  }
  for (const key of ["page_action", "action"]) {
    if (manifest[key] && manifest[key].default_icon) {
      add(manifest[key].default_icon);
    }
  }

  // web_accessible_resources
  if (Array.isArray(manifest.web_accessible_resources)) {
    for (const entry of manifest.web_accessible_resources) {
      if (Array.isArray(entry.resources)) entry.resources.forEach(add);
    }
  }

  // _locales (auto-discovered, not listed in manifest fields)
  if (manifest.default_locale) {
    const localesDir = join(SRC, "_locales");
    if (existsSync(localesDir)) {
      for (const lang of readdirSync(localesDir, { withFileTypes: true })) {
        if (lang.isDirectory()) {
          const p = `_locales/${lang.name}/messages.json`;
          if (existsSync(join(SRC, p))) files.add(p);
        }
      }
    }
  }

  // Dynamically loaded files (not in manifest, loaded via fetchResource at runtime)
  const resDir = join(SRC, "res");
  if (existsSync(resDir)) {
    for (const f of readdirSync(resDir)) files.add(join("res", f));
  }
  // Runtime-fetched bundles (worker/polyfill/main lists live in one module)
  const bundleFilesPath = join(SRC, "js/bundle-files.js");
  if (existsSync(bundleFilesPath)) {
    const src = readFileSync(bundleFilesPath, "utf-8");
    for (const m of src.matchAll(/["'](js\/[^"']+\.js)["']/g)) files.add(m[1]);
  }
  const fragment = "js/content/isolated/picker/fragment.html";
  if (existsSync(join(SRC, fragment))) files.add(fragment);

  return files;
}

// ── scan HTML for asset refs ─────────────────────────────────────────────────

function scanHtmlAssets(htmlPath) {
  const html = readFileSync(htmlPath, "utf-8");
  const assets = [];

  // <script src="...">
  for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/gi)) assets.push(m[1]);
  // <link rel="stylesheet" href="...">
  for (const m of html.matchAll(/<link[^>]+href="([^"]+)"[^>]*>/gi)) {
    if (/rel=["']?stylesheet/i.test(m[0])) assets.push(m[1]);
  }
  // <img src="...">
  for (const m of html.matchAll(/<img[^>]+src="([^"]+)"/gi)) assets.push(m[1]);

  return assets;
}

function resolveAsset(htmlRel, assetRel) {
  // Absolute from addon root
  if (assetRel.startsWith("/")) return assetRel.slice(1);
  // External URL or data URI
  if (/^(https?:|data:)/i.test(assetRel)) return null;
  // Relative to the HTML file's directory
  return join(dirname(htmlRel), assetRel);
}

function collectAllFiles(manifestFiles) {
  const all = new Set(manifestFiles);
  for (const relPath of manifestFiles) {
    if (!relPath.endsWith(".html")) continue;
    const fullPath = join(SRC, relPath);
    if (!existsSync(fullPath)) continue;
    for (const asset of scanHtmlAssets(fullPath)) {
      const resolved = resolveAsset(relPath, asset);
      if (resolved && existsSync(join(SRC, resolved))) all.add(resolved);
    }
  }
  return all;
}

async function build() {
  console.log("==> Linting addon source…");
  const lintResult = await webExt.cmd.lint({
    sourceDir: SRC,
    warningsAsErrors: false,
    output: "none",
  }, { shouldExitProgram: false });
  const s = lintResult.summary;
  if (s.errors > 0) {
    console.error(`Lint found ${s.errors} errors, aborting`);
    process.exit(1);
  }
  if (s.warnings > 0) {
    console.log(`Lint passed with ${s.warnings} warnings`);
  } else {
    console.log("Lint OK");
  }

  // Determine which manifest file to use
  const srcName = MANIFEST_VERSION === "2" ? "manifest.v2.json" : "manifest.json";
  const manifestPath = join(SRC, srcName);
  if (!existsSync(manifestPath)) {
    console.error(`Manifest ${srcName} not found`);
    process.exit(1);
  }

  // Collect files from manifest + HTML scan + runtime-fetched bundles
  const manifestFiles = collectManifestFiles(manifestPath);
  const allowedFiles = collectAllFiles(manifestFiles);
  console.log(`Source manifest references ${allowedFiles.size} files`);

  if (existsSync(DIST)) {
    await rm(DIST, { recursive: true, force: true });
  }
  await mkdir(DIST, { recursive: true });

  let jsCount = 0;
  let cssCount = 0;
  let htmlCount = 0;
  let copyCount = 0;

  for (const rel of allowedFiles) {
    if (rel === "") {
      const manifestContent = await readFile(manifestPath, "utf-8");
      await writeFile(join(DIST, "manifest.json"), manifestContent, "utf-8");
      copyCount++;
      continue;
    }

    const srcPath = join(SRC, rel);
    const outPath = join(DIST, rel);
    await mkdir(dirname(outPath), { recursive: true });
    let code;
    try {
      code = await readFile(srcPath, "utf-8");
    } catch {
      continue; // skip files that don't exist
    }
    if (rel.endsWith(".js")) {
      const result = await minify(code, TERSER_OPTS);
      if (result.error) {
        throw new Error(`terser failed on ${rel}: ${result.error}`);
      }
      await writeFile(outPath, result.code ?? "", "utf-8");
      jsCount++;
    } else if (rel.endsWith(".css")) {
      await writeFile(outPath, minifyCSS(code), "utf-8");
      cssCount++;
    } else if (rel.endsWith(".html")) {
      await writeFile(outPath, minifyHTML(code), "utf-8");
      htmlCount++;
    } else {
      await writeFile(outPath, code, "utf-8");
      copyCount++;
    }
  }

  console.log(`Built dist/: ${jsCount} JS minified, ${cssCount} CSS minified, ${htmlCount} HTML minified, ${copyCount} files copied`);

  const distRoot = join(DIST, "..");
  const suffix = MANIFEST_VERSION === "3" ? "" : `-mv${MANIFEST_VERSION}`;
  const xpiName = `webhid-addon${suffix}.xpi`;
  console.log("==> Packaging addon XPI…");
  await webExt.cmd.build({
    sourceDir: DIST,
    artifactsDir: distRoot,
    overwriteDest: true,
    filename: xpiName,
  }, { shouldExitProgram: false });
  console.log(`Created ${join(distRoot, xpiName)}`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
