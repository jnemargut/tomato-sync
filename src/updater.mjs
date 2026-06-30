// App updater — keeps the Playdate .pdx apps (Crankcaster, RWLP) up to date.
// Before a content sync, compare each INSTALLED app's build (from its pdxinfo) to
// the latest published on R2; if R2 is newer, download the new .pdx (zipped),
// extract it, and swap it in on the device. Only touches apps already installed
// (it never installs a new app — folks get those from itch). Degrades quietly if
// the apps manifest isn't published yet, so content sync still runs.
//
// R2 layout the user publishes:
//   apps.json  = { "<bundleID>": { "version":"1.4", "build":1407, "pdx":"<url or relative>.zip" }, ... }
//   each pdx zip contains a single <Name>.pdx/ folder (with pdxinfo inside).

import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gamesRoot, fetchJson, downloadTo } from "./core.mjs";
import { APPS_MANIFEST } from "./endpoints.mjs";
const execFileP = promisify(execFile);

// Where the version manifest + zips live (resolved from local/env config).
const MANIFEST_URL = APPS_MANIFEST;

// pdxinfo is a flat key=value text file (name, bundleID, version, buildNumber…).
function parsePdxinfo(text) {
  const o = {};
  for (const ln of String(text).split(/\r?\n/)) { const m = ln.match(/^([^=]+)=(.*)$/); if (m) o[m[1].trim()] = m[2].trim(); }
  return o;
}
const buildOf = (info) => parseInt(info?.buildNumber, 10) || 0;

// Find the installed .pdx for a bundleID by scanning Games/*.pdx/pdxinfo.
async function findInstalled(bundleId) {
  const g = gamesRoot(); if (!g) return null;
  let entries; try { entries = await fsp.readdir(g, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.toLowerCase().endsWith(".pdx")) continue;
    try {
      const info = parsePdxinfo(await fsp.readFile(path.join(g, e.name, "pdxinfo"), "utf8"));
      if (info.bundleID === bundleId) return { dir: path.join(g, e.name), name: e.name, info };
    } catch { /* unreadable pdx — skip */ }
  }
  return null;
}

async function extractZip(zip, dest) {
  await fsp.mkdir(dest, { recursive: true });
  if (process.platform === "win32") await execFileP("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`], { timeout: 120000 });
  else await execFileP("unzip", ["-o", "-q", zip, "-d", dest], { timeout: 120000 });
}

// Update every installed app among bundleIds. Returns { ok, updated:[], checked:[] }.
export async function updateApps(bundleIds, { onLog = () => {}, dryRun = false } = {}) {
  let manifest;
  try { manifest = await fetchJson(MANIFEST_URL); }
  catch (e) { onLog(`(app updates unavailable: ${e.message})`); return { ok: false, reason: e.message, updated: [], checked: [] }; }

  const updated = [], checked = [];
  for (const bundleId of bundleIds) {
    const latest = manifest[bundleId]; if (!latest) continue;          // app not published for update
    const inst = await findInstalled(bundleId); if (!inst) continue;   // not installed → never install new
    checked.push(bundleId);
    const have = buildOf(inst.info), wantBuild = parseInt(latest.build, 10) || 0;
    if (wantBuild <= have) continue;                                   // already current
    const label = inst.info.name || bundleId;
    onLog(`⤓ update ${label}: build ${have} → ${wantBuild} (v${latest.version || "?"})`);
    if (dryRun) { updated.push(`${label} ${have}→${wantBuild}`); continue; }

    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "tomato-pdx-"));
    try {
      const pdxUrl = /^https?:/.test(latest.pdx) ? latest.pdx : new URL(latest.pdx, MANIFEST_URL).href;
      const zip = path.join(tmp, "app.pdx.zip");
      await downloadTo(pdxUrl, zip);
      const ex = path.join(tmp, "ex");
      await extractZip(zip, ex);
      const inner = (await fsp.readdir(ex, { withFileTypes: true })).find((e) => e.isDirectory() && e.name.toLowerCase().endsWith(".pdx"));
      if (!inner) throw new Error("no .pdx folder inside the zip");
      const newInfo = parsePdxinfo(await fsp.readFile(path.join(ex, inner.name, "pdxinfo"), "utf8"));
      if (newInfo.bundleID !== bundleId) throw new Error("zip is for a different app");
      // Swap safely: stage next to the old folder, then replace (same filesystem).
      const g = gamesRoot();
      const staged = path.join(g, inst.name + ".updating");
      await fsp.rm(staged, { recursive: true, force: true });
      await fsp.cp(path.join(ex, inner.name), staged, { recursive: true });
      await fsp.rm(inst.dir, { recursive: true, force: true });
      await fsp.rename(staged, inst.dir);
      updated.push(`${label} → v${latest.version || wantBuild}`);
      onLog(`✓ updated ${label}`);
    } catch (e) { onLog(`✗ update failed for ${bundleId}: ${e.message}`); }
    finally { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
  }
  return { ok: true, updated, checked };
}
