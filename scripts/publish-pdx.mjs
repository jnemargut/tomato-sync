#!/usr/bin/env node
// publish-pdx — one command to package a compiled .pdx for app auto-update.
// Reads the .pdx's pdxinfo, zips the bundle, and merges its version/build into
// apps.json. Drop the resulting zip + apps.json on R2 and Tomato Sync will offer
// the update to everyone running an older build.
//
// Usage:
//   node scripts/publish-pdx.mjs <path/to/App.pdx> [--out dist-apps]
//   node scripts/publish-pdx.mjs ~/Desktop/Crankcaster.pdx
//   node scripts/publish-pdx.mjs ~/Desktop/Crankcaster.pdx --upload --bucket my-bucket   # needs wrangler
//
// Output (in --out, default ./dist-apps):
//   <slug>.b<build>.pdx.zip   the zipped app (top-level folder is <Name>.pdx/)
//   apps.json                 merged manifest Tomato Sync reads

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);

const pdxPath = path.resolve(args.find((a) => !a.startsWith("--")) || "");
const outDir = path.resolve(flag("--out", "dist-apps"));
const manifestPath = path.resolve(flag("--manifest", path.join(outDir, "apps.json")));

function die(msg) { console.error("✗ " + msg); process.exit(1); }

if (!pdxPath || !fs.existsSync(pdxPath) || !fs.statSync(pdxPath).isDirectory() || !pdxPath.toLowerCase().endsWith(".pdx"))
  die(`pass a compiled .pdx folder. got: ${pdxPath || "(nothing)"}`);

const infoPath = path.join(pdxPath, "pdxinfo");
if (!fs.existsSync(infoPath)) die(`no pdxinfo in ${pdxPath} — is it a compiled .pdx?`);
const info = {};
for (const ln of fs.readFileSync(infoPath, "utf8").split(/\r?\n/)) { const m = ln.match(/^([^=]+)=(.*)$/); if (m) info[m[1].trim()] = m[2].trim(); }

const bundleID = info.bundleID;
const version = info.version || "0";
const build = parseInt(info.buildNumber, 10) || 0;
const name = info.name || path.basename(pdxPath, ".pdx");
if (!bundleID) die("pdxinfo has no bundleID");
if (!build) console.warn("! pdxinfo has no buildNumber — Tomato Sync compares builds, so set one to ship updates.");

const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || bundleID.split(".").pop();
const zipName = `${slug}.b${build}.pdx.zip`;

await fsp.mkdir(outDir, { recursive: true });
const zipPath = path.join(outDir, zipName);
await fsp.rm(zipPath, { force: true });

// zip so the archive's single top-level entry is "<Name>.pdx/" (what the updater expects)
try {
  execFileSync("zip", ["-rq", zipPath, path.basename(pdxPath)], { cwd: path.dirname(pdxPath), stdio: "inherit" });
} catch (e) { die(`zip failed (is the 'zip' CLI installed?): ${e.message}`); }

// merge into apps.json
let manifest = {};
try { manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8")); } catch { /* fresh */ }
manifest[bundleID] = { version, build, pdx: zipName };
await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const zipSize = (fs.statSync(zipPath).size / 1048576).toFixed(1);
console.log(`\n✓ packaged ${name}  v${version} (build ${build})`);
console.log(`  ${path.relative(process.cwd(), zipPath)}  (${zipSize} MB)`);
console.log(`  ${path.relative(process.cwd(), manifestPath)}  ← ${bundleID} now points to ${zipName}`);

// optional upload to R2 — prefers rclone (matches the RWLP pipeline), falls back
// to wrangler. Pass --bucket <name> (or R2_BUCKET) for the bucket that serves apps.json.
const have = (bin) => { try { execFileSync(bin, ["--version"], { stdio: "ignore" }); return true; } catch { return false; } };
if (has("--upload")) {
  const bucket = flag("--bucket", process.env.R2_BUCKET);
  if (!bucket) die("--upload needs --bucket <name> (or set R2_BUCKET)");
  const remote = flag("--remote", "r2");   // rclone remote name
  const useRclone = have("rclone");
  if (!useRclone && !have("wrangler")) die("--upload needs rclone (configured) or wrangler on PATH");
  for (const [file, key] of [[zipPath, zipName], [manifestPath, "apps.json"]]) {
    console.log(`↑ ${key} → ${bucket}`);
    try {
      if (useRclone) execFileSync("rclone", ["copyto", file, `${remote}:${bucket}/${key}`, "--s3-no-check-bucket"], { stdio: "inherit" });
      else execFileSync("wrangler", ["r2", "object", "put", `${bucket}/${key}`, `--file=${file}`], { stdio: "inherit" });
    } catch (e) { die(`upload failed: ${e.message}`); }
  }
  console.log("\n✓ uploaded to R2. Tomato Sync will offer the update on the next sync.");
} else {
  const rel = (p) => path.relative(process.cwd(), p);
  console.log(`\nNext: upload both files to the R2 bucket that serves apps.json, e.g.`);
  console.log(`  rclone copyto ${rel(zipPath)} r2:<bucket>/${zipName} --s3-no-check-bucket`);
  console.log(`  rclone copyto ${rel(manifestPath)} r2:<bucket>/apps.json --s3-no-check-bucket`);
  console.log(`  (or re-run with --upload --bucket <name>)`);
}
